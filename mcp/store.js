// @ts-check
import { randomBytes } from "node:crypto";
import { formatArgs } from "./format.js";

const DefaultMaxEntries = 20000;

/**
 * One entry that can't be displayed must never fail its batch, because the
 * extension would just keep resending it and nothing after it would arrive.
 *
 * @param {any[]} args
 * @returns {string}
 */
function renderArgs(
	args)
{
	try {
		return formatArgs(args);
	} catch {
		return JSON.stringify(args);
	}
}

/**
 * @typedef {object} LogFilter
 * @property {string[]} [levels]  Console methods to include, like "error".
 * @property {string} [extension]  Extension ID or name.
 * @property {string} [browser]  Browser ID or name.
 * @property {string} [filename]  Substring of the page or script filename.
 * @property {string} [search]  Case-insensitive regular expression to match
 * against the formatted message.
 * @property {number} [since]  Only include entries logged at or after this time.
 */

/**
 * @typedef {object} Browser
 * One install of the stdout extension, in one profile of one browser.
 * @property {string} id  A short form of its buffer ID, for agents to pass.
 * @property {string|undefined} bufferId
 * @property {string|null} name  What the extension calls it, or null if it
 * predates browser names.
 * @property {number} syncPosition  The last entry from its buffer that we
 * have, numbered by the extension.
 * @property {number} lastCheckInAt  When it last sent a batch, accepted or
 * not, or 0.
 * @property {number|null} daemonLinkVersion  The Daemon Link version it last
 * sent, which is 0 if it predates them, or null if it hasn't sent a batch we
 * could read.
 * @property {string|null} batchRejection  Why we last refused its batch,
 * until one is accepted.
 */

/**
 * @typedef {Pick<Browser, "id"|"name"|"lastCheckInAt"|"daemonLinkVersion"|"batchRejection"> & { label: string }} BrowserStatus
 */

	// long enough to tell apart any two browsers on one machine
const BrowserIdLength = 8;

/**
 * @param {string|undefined|null} bufferId
 * @returns {string}
 */
export function getBrowserId(
	bufferId)
{
	return typeof bufferId === "string" && bufferId
		? bufferId.slice(0, BrowserIdLength)
		: "unknown";
}

/**
 * Names for agents to see, with the ID added to any name that two browsers
 * share, such as two profiles of the same Chrome.
 *
 * @param {{ id: string, name: string|null }[]} browsers
 * @returns {Map<string, string>} Labels by browser ID.
 */
export function getBrowserLabels(
	browsers)
{
	const counts = new Map();

	for (const { name } of browsers) {
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}

	return new Map(browsers.map(({ id, name }) => [
		id,
		!name ? `browser ${id}` : counts.get(name) > 1 ? `${name} (${id})` : name,
	]));
}

/**
 * @param {LogFilter} [filter]
 * @param {boolean} [includeMarks]
 * @param {(browser: string) => Set<string>} [findBrowsers]
 * @returns {(entry: object) => boolean}
 */
function createMatcher(
	{ levels, extension, browser, filename, search, since } = {},
	includeMarks = true,
	findBrowsers = () => new Set())
{
	const levelSet = levels?.length ? new Set(levels) : null;
	const extensionLower = extension?.toLowerCase();
	const browserIds = browser ? findBrowsers(browser) : null;
	const pattern = search ? new RegExp(search, "i") : null;

	return (entry) => {
		if (since && !(entry.time >= since)) {
			return false;
		}

		if (entry.mark) {
				// marks bracket a repro, so show them whatever the other filters are
			return includeMarks;
		}

		return (!levelSet || levelSet.has(entry.method))
			&& (!extensionLower || entry.extensionId === extension
				|| entry.extensionName?.toLowerCase() === extensionLower)
			&& (!browserIds || browserIds.has(entry.browserId))
			&& (!filename || entry.filename?.includes(filename))
			&& (!pattern || pattern.test(entry.text));
	};
}

/**
 * Holds a copy of the log entries buffered by the stdout extension in each
 * browser that sends them.  Each browser sends its entries in order of their
 * sequence numbers, and has its own sync position.  Entries from every browser
 * are renumbered into one list as they arrive, so that cursors cover them all
 * and marks added by an agent can go between them.
 *
 * Reads hand out cursors, which are opaque to everything else.  A cursor only
 * means something to the store that issued it, since a restarted daemon numbers
 * the same entries differently.
 */
export class LogStore
{
	constructor(
		{ maxEntries = DefaultMaxEntries } = {})
	{
		this.maxEntries = maxEntries;
		this.runId = randomBytes(2).toString("hex");
			/** @type {Map<string, Browser>} */
		this.browsers = new Map();
			// why the daemon last refused a batch it couldn't tie to a browser, such
			// as from an extension that predates the buffer ID header, until a batch
			// is accepted
			/** @type {string|null} */
		this.batchRejection = null;
		this.waiters = new Set();
			// the last sequence number we've assigned
		this.maxSeq = 0;
		this.entries = [];
		this.sources = new Map();
		this.loadIds = new Set();
	}

	/**
	 * @param {string|undefined} bufferId
	 * @returns {Browser}
	 */
	getBrowser(
		bufferId)
	{
		const id = getBrowserId(bufferId);
		let browser = this.browsers.get(id);

		if (!browser || browser.bufferId !== bufferId) {
				// a recreated buffer numbers its entries from the start, so it needs a
				// fresh sync position.  the entries we already have from it stay.
			browser = {
				id,
				bufferId,
				name: browser?.name ?? null,
				syncPosition: 0,
				lastCheckInAt: 0,
				daemonLinkVersion: null,
				batchRejection: null,
			};
			this.browsers.set(id, browser);
		}

		return browser;
	}

	/**
	 * @returns {BrowserStatus[]} The browsers that have checked in, most recent
	 * first.
	 */
	getBrowsers()
	{
		const browsers = [...this.browsers.values()];
		const labels = getBrowserLabels(browsers);

		return browsers
			.map(({ id, name, lastCheckInAt, daemonLinkVersion, batchRejection }) =>
				({ id, name, label: labels.get(id), lastCheckInAt, daemonLinkVersion, batchRejection }))
			.sort((a, b) => b.lastCheckInAt - a.lastCheckInAt);
	}

	/**
	 * @param {string} nameOrId  A browser's ID, name or label, ignoring case.
	 * @returns {Set<string>} The IDs of the browsers it could mean.
	 */
	findBrowsers(
		nameOrId)
	{
		const lower = nameOrId.toLowerCase();

		return new Set(this.getBrowsers()
			.filter(({ id, name, label }) => id === nameOrId || name?.toLowerCase() === lower
				|| label.toLowerCase() === lower)
			.map(({ id }) => id));
	}

	add(
		entry)
	{
		const stored = { ...entry, seq: ++this.maxSeq };

		this.entries.push(stored);

		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}

		return stored;
	}

	/**
	 * Accept a batch of entries from a browser, if it continues from the last one
	 * we have from that browser.  Otherwise, the returned position tells the
	 * extension where to resend from.
	 *
	 * @param {import("../extension/daemon-link.js").IngestRequest} batch
	 * @returns {import("../extension/daemon-link.js").IngestReply}
	 */
	ingest(
		{ bufferId, browserName, syncPosition, entries, linkVersion })
	{
		const browser = this.getBrowser(bufferId);

		browser.lastCheckInAt = Date.now();
		browser.daemonLinkVersion = Number.isInteger(linkVersion) ? linkVersion : 0;

		if (typeof browserName === "string" && browserName.trim()) {
			browser.name = browserName.trim();
		}

		if (syncPosition !== browser.syncPosition || !Array.isArray(entries)) {
			return { syncPosition: browser.syncPosition };
		}

		const added = [];

		for (const { seq, ...entry } of entries.filter(Boolean)) {
			if (Number.isInteger(seq) && seq > browser.syncPosition && Array.isArray(entry.args)) {
				const { loadId } = entry;
					// the first entry from each page load, so a restarted service
					// worker or reopened popup is easy to spot
				const newLoad = typeof loadId === "string" && !this.loadIds.has(loadId);
				const stored = this.add({ ...entry, browserId: browser.id, newLoad, text: renderArgs(entry.args) });

				browser.syncPosition = seq;
				this.loadIds.add(loadId);
				this.addSource(stored);
				added.push(stored);
			}
		}

		if (added.length) {
			for (const waiter of this.waiters) {
				waiter(added);
			}
		}

			// only a batch that lined up gets here.  a request that just asks for our
			// position succeeds between failed resends, so it doesn't count.
		browser.batchRejection = null;
		this.batchRejection = null;

		return { syncPosition: browser.syncPosition };
	}

	/**
	 * Remember that a batch couldn't be accepted, so agents can be told that logs
	 * aren't arriving.  Otherwise, it looks like the extension has nothing to send.
	 *
	 * @param {string} reason
	 * @param {string} [bufferId]  Missing from extensions that predate the buffer
	 * ID header.
	 */
	recordRejectedBatch(
		reason,
		bufferId)
	{
		if (bufferId) {
			const browser = this.getBrowser(bufferId);

			browser.lastCheckInAt = Date.now();
			browser.batchRejection = reason;
		} else {
			this.batchRejection = reason;
		}
	}

	/**
	 * Add a line that an agent can use to bracket a repro.
	 *
	 * @param {string} label
	 * @returns {{ entry: object, cursor: string }} The new entry, and a cursor for
	 * reading what's logged after it.
	 */
	addMark(
		label)
	{
		const entry = this.add({ mark: true, time: Date.now(), method: "mark", text: label });

		return { entry, cursor: this.createCursor(entry.seq) };
	}

	/**
	 * @returns {string} A cursor for reading whatever is logged from now on.
	 */
	getCursor()
	{
		return this.createCursor(this.maxSeq);
	}

	/**
	 * @param {number} seq
	 * @returns {string}
	 */
	createCursor(
		seq)
	{
		return `${this.runId}:${seq}`;
	}

	/**
	 * @param {string} cursor
	 * @returns {number|null} The sequence number it stands for, or null if it
	 * didn't come from this store.
	 */
	readCursor(
		cursor)
	{
		const [runId, position] = String(cursor).split(":");
		const seq = Number(position);

		return runId === this.runId && Number.isInteger(seq) && seq >= 0 && seq <= this.maxSeq
			? seq
			: null;
	}

	/**
	 * @param {number} seq
	 * @param {number} limit
	 * @param {(entry: object) => boolean} matches
	 * @returns {object[]} The first matching entries after `seq`.
	 */
	entriesAfter(
		seq,
		limit,
		matches)
	{
		const start = this.entries.findIndex((entry) => entry.seq > seq);
		const entries = [];

		for (let i = start; i !== -1 && i < this.entries.length && entries.length < limit; i++) {
			if (matches(this.entries[i])) {
				entries.push(this.entries[i]);
			}
		}

		return entries;
	}

	addSource(
		{ browserId, extensionId, extensionName, filename, time })
	{
			// an unpacked extension loaded from the same folder has the same ID in
			// every browser, so keep each browser's copy apart
		const key = `${browserId}/${extensionId}`;
		let source = this.sources.get(key);

		if (!source) {
			source = { browserId, extensionId, extensionName, count: 0, lastTime: 0, filenames: {} };
			this.sources.set(key, source);
		}

		source.extensionName = extensionName ?? source.extensionName;
		source.count++;
		source.lastTime = Math.max(source.lastTime, time ?? 0);
		source.filenames[filename] = (source.filenames[filename] ?? 0) + 1;
	}

	/**
	 * With `around`, returns up to `limit` matching entries centered on that entry
	 * number.  With `after`, returns the entries following that cursor, or the
	 * latest ones and a true `cursorReset` if the cursor is from an earlier daemon.
	 * Otherwise, returns the latest entries.
	 *
	 * @param {{ after?: string, around?: number, limit?: number, filter?: LogFilter }} query
	 * @returns {{ entries: object[], cursor: string, cursorReset: boolean, hasMore: boolean }}
	 * `cursor` is where to continue from.  `hasMore` means that paging forward
	 * stopped at the limit.
	 */
	query(
		{ after, around, limit = 100, filter } = {})
	{
		const matches = createMatcher(filter, true, (browser) => this.findBrowsers(browser));

		if (typeof around === "number") {
			const entries = this.around(around, limit, matches);
			const cursor = entries.length ? this.createCursor(entries.at(-1).seq) : this.getCursor();

			return { entries, cursor, cursorReset: false, hasMore: false };
		}

		const position = after === undefined ? null : this.readCursor(after);

		if (position !== null) {
			const entries = this.entriesAfter(position, limit, matches);
			const hasMore = entries.length === limit;
			const cursor = hasMore ? this.createCursor(entries.at(-1).seq) : this.getCursor();

			return { entries, cursor, cursorReset: false, hasMore };
		}

		const entries = [];

		for (let i = this.entries.length - 1; i >= 0 && entries.length < limit; i--) {
			if (matches(this.entries[i])) {
				entries.unshift(this.entries[i]);
			}
		}

		return { entries, cursor: this.getCursor(), cursorReset: after !== undefined, hasMore: false };
	}

	around(
		seq,
		limit,
		matches)
	{
		let center = this.entries.findIndex((entry) => entry.seq >= seq);

		if (center === -1) {
			center = this.entries.length;
		}

		const before = [];
		const after = [];
		const beforeLimit = Math.floor((limit - 1) / 2);

			// the entry asked about is included even if it doesn't match the filter
		if (this.entries[center]?.seq === seq) {
			after.push(this.entries[center++]);
		}

		for (let i = center - 1 - (after.length ? 1 : 0); i >= 0 && before.length < beforeLimit; i--) {
			if (matches(this.entries[i])) {
				before.unshift(this.entries[i]);
			}
		}

		for (let i = center; i < this.entries.length && before.length + after.length < limit; i++) {
			if (matches(this.entries[i])) {
				after.push(this.entries[i]);
			}
		}

		return [...before, ...after];
	}

	/**
	 * Wait for entries after the `after` cursor that match the filter, or for new
	 * ones if there's no cursor.  A cursor from an earlier daemon also waits for new
	 * ones, since its entries can't be told apart from ones the agent has seen, and
	 * returns a true `cursorReset`.
	 *
	 * @param {{ after?: string, limit?: number, filter?: LogFilter, timeoutMs: number }} options
	 * @returns {{ promise: Promise<{ entries: object[], cursor: string, cursorReset: boolean, timedOut: boolean }>, cancel: () => void }}
	 */
	wait(
		{ after, limit = 100, filter, timeoutMs })
	{
			// a mark isn't something the extension logged, so it shouldn't end the wait
		const matches = createMatcher(filter, false, (browser) => this.findBrowsers(browser));
		const position = after === undefined ? null : this.readCursor(after);
		const cursorReset = after !== undefined && position === null;
		const found = (entries) => ({
			entries,
			cursor: this.createCursor(entries.at(-1).seq),
			cursorReset,
			timedOut: false,
		});
		const existing = position === null ? [] : this.entriesAfter(position, limit, matches);

		if (existing.length) {
			return { promise: Promise.resolve(found(existing)), cancel() {} };
		}

		let cancel;
		const promise = new Promise((resolve) => {
			const finish = (result) => {
				clearTimeout(timer);
				this.waiters.delete(waiter);
				resolve(result);
			};
			const giveUp = () => finish({ entries: [], cursor: this.getCursor(), cursorReset, timedOut: true });
			const waiter = (added) => {
				const entries = added.filter(matches).slice(0, limit);

				if (entries.length) {
					finish(found(entries));
				}
			};
			const timer = setTimeout(giveUp, timeoutMs);

			this.waiters.add(waiter);
			cancel = giveUp;
		});

		return { promise, cancel };
	}

	getSources()
	{
		return [...this.sources.values()];
	}
}
