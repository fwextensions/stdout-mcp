// @ts-check
import { randomBytes } from "node:crypto";
import { formatArgs } from "./format.js";

const DefaultMaxEntries = 20000;

/**
 * @typedef {object} LogFilter
 * @property {string[]} [levels]  Console methods to include, like "error".
 * @property {string} [extension]  Extension ID or name.
 * @property {string} [filename]  Substring of the page or script filename.
 * @property {string} [search]  Case-insensitive regular expression to match
 * against the formatted message.
 * @property {number} [since]  Only include entries logged at or after this time.
 */

/**
 * @param {LogFilter} [filter]
 * @param {boolean} [includeMarks]
 * @returns {(entry: object) => boolean}
 */
function createMatcher(
	{ levels, extension, filename, search, since } = {},
	includeMarks = true)
{
	const levelSet = levels?.length ? new Set(levels) : null;
	const extensionLower = extension?.toLowerCase();
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
			&& (!filename || entry.filename?.includes(filename))
			&& (!pattern || pattern.test(entry.text));
	};
}

/**
 * Holds a copy of the log entries buffered by the stdout extension, which sends
 * them in order of their sequence numbers.  Entries are renumbered as they
 * arrive, so that marks added by an agent can go between them.
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
		this.bufferId = null;
		this.lastIngestAt = 0;
			// the Extension Link version the stdout extension last sent, which is 0
			// if it predates them, or null if we haven't heard from it
		this.extensionLinkVersion = null;
		this.waiters = new Set();
			// the last sequence number we've assigned.  this keeps counting when the
			// buffer is reset, so that cursors from before then still work.
		this.maxSeq = 0;
		this.reset();
	}

	reset(
		bufferId = null)
	{
		this.bufferId = bufferId;
		this.entries = [];
			// the last entry from the extension's buffer that we have, numbered by
			// the extension
		this.syncPosition = 0;
		this.sources = new Map();
		this.loadIds = new Set();
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
	 * Accept a batch of entries from the extension, if it continues from the last
	 * one we have.  Otherwise, the returned position tells the extension where to
	 * resend from.
	 *
	 * @param {import("../extension/link.js").IngestRequest} batch
	 * @returns {import("../extension/link.js").IngestReply}
	 */
	ingest(
		{ bufferId, syncPosition, entries, linkVersion })
	{
		if (bufferId !== this.bufferId) {
				// the extension's buffer was recreated, so its sequence numbers
				// started over
			this.reset(bufferId);
		}

		this.lastIngestAt = Date.now();
		this.extensionLinkVersion = Number.isInteger(linkVersion) ? linkVersion : 0;

		if (syncPosition !== this.syncPosition || !Array.isArray(entries)) {
			return { syncPosition: this.syncPosition };
		}

		const added = [];

		for (const { seq, ...entry } of entries.filter(Boolean)) {
			if (Number.isInteger(seq) && seq > this.syncPosition && Array.isArray(entry.args)) {
				const { loadId } = entry;
					// the first entry from each page load, so a restarted service
					// worker or reopened popup is easy to spot
				const newLoad = typeof loadId === "string" && !this.loadIds.has(loadId);
				const stored = this.add({ ...entry, newLoad, text: formatArgs(entry.args) });

				this.syncPosition = seq;
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

		return { syncPosition: this.syncPosition };
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
		{ extensionId, extensionName, filename, time })
	{
		let source = this.sources.get(extensionId);

		if (!source) {
			source = { extensionId, extensionName, count: 0, lastTime: 0, filenames: {} };
			this.sources.set(extensionId, source);
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
		const matches = createMatcher(filter);

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
		const matches = createMatcher(filter, false);
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
