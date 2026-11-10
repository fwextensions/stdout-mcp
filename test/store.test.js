import { test } from "node:test";
import assert from "node:assert/strict";
import { LogStore } from "../mcp/store.js";

const entry = (seq, args = [`message ${seq}`], extra = {}) => ({
	seq,
	time: 1000 + seq,
	extensionId: "ext1",
	extensionName: "My Extension",
	filename: "sw.js",
	method: "log",
	args,
	...extra,
});

test("accepts only batches that continue from the last entry", () => {
	const store = new LogStore();

	assert.deepEqual(store.ingest({ bufferId: "a", syncPosition: null, entries: [] }), { syncPosition: 0 });
	assert.deepEqual(store.ingest({ bufferId: "a", syncPosition: 5, entries: [entry(6)] }), { syncPosition: 0 });
	assert.deepEqual(store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(3), entry(4)] }), { syncPosition: 4 });
	assert.deepEqual(store.ingest({ bufferId: "a", syncPosition: 4, entries: [entry(5)] }), { syncPosition: 5 });
	assert.equal(store.entries.length, 3);
});

test("starts over when the buffer ID changes", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1), entry(2)] });
	assert.deepEqual(store.ingest({ bufferId: "b", syncPosition: 2, entries: [entry(3)] }), { syncPosition: 0 });
	assert.equal(store.entries.length, 0);
	store.ingest({ bufferId: "b", syncPosition: 0, entries: [entry(1)] });
	assert.equal(store.entries.length, 1);
});

test("queries the tail or pages forward from a cursor", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1)] });

	const afterFirst = store.getCursor();

	store.ingest({ bufferId: "a", syncPosition: 1, entries: [2, 3, 4, 5].map((seq) => entry(seq)) });
	assert.deepEqual(store.query({ limit: 2 }).entries.map(({ seq }) => seq), [4, 5]);

	const page = store.query({ after: afterFirst, limit: 2 });

	assert.deepEqual(page.entries.map(({ seq }) => seq), [2, 3]);
	assert.equal(page.hasMore, true);

	const lastPage = store.query({ after: page.cursor, limit: 10 });

	assert.deepEqual(lastPage.entries.map(({ seq }) => seq), [4, 5]);
	assert.equal(lastPage.hasMore, false);
	assert.deepEqual(store.query({ after: lastPage.cursor }).entries, []);
	assert.equal(lastPage.cursor, store.getCursor());
});

test("the cursor from a filtered read skips the entries that didn't match", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1, ["match"]), entry(2, ["other"])] });

	const { entries, cursor } = store.query({ filter: { search: "match" } });

	assert.equal(entries.length, 1);
	assert.deepEqual(store.query({ after: cursor }).entries, []);
});

test("the cursor from a read around an entry continues after the last one shown", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [1, 2, 3, 4, 5].map((seq) => entry(seq)) });

	const { cursor, hasMore } = store.query({ around: 2, limit: 3 });

	assert.equal(hasMore, false);
	assert.deepEqual(store.query({ after: cursor }).entries.map(({ seq }) => seq), [4, 5]);
});

for (const [name, getCursor] of [
	["an earlier daemon", () => "old-run:2"],
	["garbage", () => "garbage"],
	["a position this store never reached", (store) => store.createCursor(99)],
]) {
	test(`a cursor from ${name} returns the latest entries and says so`, () => {
		const store = new LogStore();

		store.ingest({ bufferId: "a", syncPosition: 0, entries: [1, 2, 3].map((seq) => entry(seq)) });

		const result = store.query({ after: getCursor(store), limit: 1 });

		assert.equal(result.cursorReset, true);
		assert.equal(result.hasMore, false);
		assert.deepEqual(result.entries.map(({ seq }) => seq), [3]);
		assert.equal(result.cursor, store.getCursor());
	});
}

test("a cursor from before the buffer was recreated still works", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1), entry(2)] });

	const cursor = store.getCursor();

	store.ingest({ bufferId: "b", syncPosition: 0, entries: [] });
	store.ingest({ bufferId: "b", syncPosition: 0, entries: [entry(1, ["new buffer"])] });

	const result = store.query({ after: cursor });

	assert.equal(result.cursorReset, false);
	assert.deepEqual(result.entries.map(({ seq, text }) => [seq, text]), [[3, "new buffer"]]);
});

test("filters by level, extension, filename and search", () => {
	const store = new LogStore();

	store.ingest({
		bufferId: "a",
		syncPosition: 0,
		entries: [
			entry(1, ["Started up"]),
			entry(2, ["Failed to fetch", { status: 404 }], { method: "error" }),
			entry(3, ["clicked"], { filename: "popup.html", extensionId: "ext2", extensionName: "Other" }),
		],
	});

	const seqs = (filter) => store.query({ filter }).entries.map(({ seq }) => seq);

	assert.deepEqual(seqs({ levels: ["error", "warn"] }), [2]);
	assert.deepEqual(seqs({ extension: "other" }), [3]);
	assert.deepEqual(seqs({ extension: "ext1" }), [1, 2]);
	assert.deepEqual(seqs({ filename: "popup" }), [3]);
	assert.deepEqual(seqs({ search: "status: 40\\d" }), [2]);
	assert.equal(store.getSources().length, 2);
});

test("waits for a matching entry", async () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1, ["ready"])] });

	const { promise } = store.wait({ filter: { search: "ready" }, timeoutMs: 1000 });

	store.ingest({ bufferId: "a", syncPosition: 1, entries: [entry(2, ["not yet"])] });
	store.ingest({ bufferId: "a", syncPosition: 2, entries: [entry(3, ["ready again"])] });

	const result = await promise;

	assert.equal(result.timedOut, false);
	assert.deepEqual(result.entries.map(({ seq }) => seq), [3]);
	assert.equal(store.waiters.size, 0);

	assert.equal(result.cursor, store.getCursor());

	const timedOut = await store.wait({ filter: { search: "never" }, timeoutMs: 20 }).promise;

	assert.equal(timedOut.timedOut, true);
	assert.equal(timedOut.cursor, store.getCursor());
	assert.equal(store.waiters.size, 0);
});

test("a wait with a current cursor returns entries it already has", async () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1)] });

	const after = store.getCursor();

	store.ingest({ bufferId: "a", syncPosition: 1, entries: [entry(2, ["ready"]), entry(3)] });

	const result = await store.wait({ after, filter: { search: "ready" }, timeoutMs: 1000 }).promise;

	assert.equal(result.timedOut, false);
	assert.equal(result.cursorReset, false);
	assert.deepEqual(result.entries.map(({ seq }) => seq), [2]);
	assert.deepEqual(store.query({ after: result.cursor }).entries.map(({ seq }) => seq), [3]);
});

test("a wait with a stale cursor ignores old entries and says so", async () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1, ["ready"])] });

	const { promise } = store.wait({ after: "old-run:0", filter: { search: "ready" }, timeoutMs: 1000 });

	store.ingest({ bufferId: "a", syncPosition: 1, entries: [entry(2, ["ready again"])] });

	const result = await promise;

	assert.equal(result.cursorReset, true);
	assert.equal(result.timedOut, false);
	assert.deepEqual(result.entries.map(({ seq }) => seq), [2]);

	const timedOut = await store.wait({ after: "old-run:0", filter: { search: "ready" }, timeoutMs: 10 }).promise;

	assert.equal(timedOut.cursorReset, true);
	assert.equal(timedOut.timedOut, true);
	assert.deepEqual(timedOut.entries, []);
});

test("renumbers entries and adds marks between them", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(7), entry(8)] });

	const { entry: mark, cursor } = store.addMark("repro start");

	assert.deepEqual(store.ingest({ bufferId: "a", syncPosition: 8, entries: [entry(9)] }), { syncPosition: 9 });
	assert.equal(mark.seq, 3);
	assert.deepEqual(store.query({ after: cursor }).entries.map(({ seq }) => seq), [4]);
	assert.deepEqual(store.entries.map(({ seq, text }) => [seq, text]),
		[[1, "message 7"], [2, "message 8"], [3, "repro start"], [4, "message 9"]]);
		// marks show up whatever the filter, but not as a source
	assert.deepEqual(store.query({ filter: { search: "9" } }).entries.map(({ seq }) => seq), [3, 4]);
	assert.equal(store.getSources()[0].count, 3);
});

test("doesn't end a wait with a mark", async () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [entry(1)] });

	const after = store.getCursor();
	const { promise } = store.wait({ filter: { search: "" }, timeoutMs: 1000 });

	store.addMark("mark");
	store.ingest({ bufferId: "a", syncPosition: 1, entries: [entry(2)] });
	assert.deepEqual((await promise).entries.map(({ text }) => text), ["message 2"]);
	assert.deepEqual((await store.wait({ after, timeoutMs: 10 }).promise).entries.map(({ text }) => text),
		["message 2"]);
});

test("flags the first entry from each page load", () => {
	const store = new LogStore();

	store.ingest({
		bufferId: "a",
		syncPosition: 0,
		entries: [
			entry(1, ["old lib"]),
			entry(2, ["a1"], { loadId: "a" }),
			entry(3, ["popup"], { loadId: "p", filename: "popup.html" }),
			entry(4, ["a2"], { loadId: "a" }),
			entry(5, ["b1"], { loadId: "b" }),
		],
	});
	assert.deepEqual(store.entries.filter(({ newLoad }) => newLoad).map(({ text }) => text),
		["a1", "popup", "b1"]);
});

test("filters by time and returns the entries around one", () => {
	const store = new LogStore();

	store.ingest({ bufferId: "a", syncPosition: 0, entries: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((seq) => entry(seq)) });

	const seqs = (query) => store.query(query).entries.map(({ seq }) => seq);

	assert.deepEqual(seqs({ filter: { since: 1007 } }), [7, 8, 9]);
	assert.deepEqual(seqs({ around: 5, limit: 5 }), [3, 4, 5, 6, 7]);
	assert.deepEqual(seqs({ around: 2, limit: 5 }), [1, 2, 3, 4, 5]);
	assert.deepEqual(seqs({ around: 9, limit: 5 }), [7, 8, 9]);
		// the center entry is included even when it doesn't match
	assert.deepEqual(seqs({ around: 5, limit: 5, filter: { search: "[2468]$" } }), [2, 4, 5, 6, 8]);
});
