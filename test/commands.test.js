import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CommandQueue, UnknownBrowser } from "../mcp/commands.js";

const createQueue = () => new CommandQueue({ getCursor: () => "now" });
const Timeouts = { pickupTimeout: 1000, runTimeout: 1000 };

test("delivers a command to a waiting poll and returns its outcome", async () => {
	const queue = createQueue();
	const { promise: polled } = queue.poll("chrome", 1000);
	const { promise } = queue.send("reload", { extension: "a" }, Timeouts);
	const [command] = await polled;

	assert.deepEqual(command, { id: 1, name: "reload", args: { extension: "a" } });
	queue.complete(command.id, { result: "done" });
	assert.deepEqual(await promise, { result: "done", cursor: "now" });
});

test("holds a command until the next poll", async () => {
	const queue = createQueue();
	const { cancel } = queue.send("reload", {}, Timeouts);
	const { promise } = queue.poll("chrome", 1000);

	assert.equal((await promise).length, 1);
	cancel();
});

test("a poll returns nothing when its time is up", async () => {
	assert.deepEqual(await createQueue().poll("chrome", 1).promise, []);
});

test("a new poll replaces an old one", async () => {
	const queue = createQueue();
	const first = queue.poll("chrome", 1000);
	const second = queue.poll("chrome", 1000);

	assert.deepEqual(await first.promise, []);

	const { cancel } = queue.send("reload", {}, Timeouts);

	assert.equal((await second.promise).length, 1);
	cancel();
});

test("a command that timed out or was cancelled never reaches the extension", async () => {
	const queue = createQueue();

	assert.deepEqual(await queue.send("reload", {}, { pickupTimeout: 1, runTimeout: 1000 }).promise, { timedOut: "pickup" });

	const { promise, cancel } = queue.send("reload", {}, Timeouts);

	cancel();
	assert.deepEqual(await promise, { cancelled: true });
	assert.deepEqual(await queue.poll("chrome", 1).promise, []);
});

test("takes the cursor when a command is picked up, not when it's queued", async () => {
	let cursor = "when queued";
	const queue = new CommandQueue({ getCursor: () => cursor });
	const { promise } = queue.send("reload", {}, Timeouts);

	cursor = "when picked up";

	const [command] = await queue.poll("chrome", 1000).promise;

	cursor = "when answered";
	queue.complete(command.id, { result: "done" });
	assert.equal((await promise).cursor, "when picked up");
});

test("a command gets its full time to run, however long it waited to be picked up", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const queue = createQueue();
	const { promise } = queue.send("reload", {}, { pickupTimeout: 100, runTimeout: 1000 });
	let outcome;

	promise.then((result) => outcome = result);
	t.mock.timers.tick(90);
	await queue.poll("chrome", 1000).promise;
	t.mock.timers.tick(990);
	await nextTurn();
	assert.equal(outcome, undefined, "timed out while running");
	t.mock.timers.tick(10);
	assert.deepEqual(await promise, { timedOut: "result", cursor: "now" });
});

test("each browser has its own poll, so two don't end each other", async () => {
	const queue = createQueue();
	const chrome = queue.poll("chrome", 1000);
	const edge = queue.poll("edge", 1000);
	let chromeDone = false;

	chrome.promise.then(() => chromeDone = true);
	await nextTurn();
	assert.equal(chromeDone, false);
	chrome.cancel();
	edge.cancel();
	assert.deepEqual(await edge.promise, []);
});

test("sends a command only to the browser it's for", async () => {
	const queue = createQueue();
	const chrome = queue.poll("chrome", 1000);
	const edge = queue.poll("edge", 1000);
	const { promise } = queue.send("reload", { extension: "a" }, { ...Timeouts, browserId: "edge" });
	const [command] = await edge.promise;

	assert.equal(command.name, "reload");
	queue.complete(command.id, { result: "done" });
	assert.equal((await promise).result, "done");
	chrome.cancel();
	assert.deepEqual(await chrome.promise, []);
});

test("a command without a browser goes to the first one to ask", async () => {
	const queue = createQueue();
	const { cancel } = queue.send("reload", {}, Timeouts);

	assert.equal((await queue.poll("edge", 1000).promise).length, 1);
	cancel();
});

test("a poll from an extension that can't say which browser it's in gets any command", async () => {
	const queue = createQueue();
	const { cancel } = queue.send("reload", {}, { ...Timeouts, browserId: "edge" });

	assert.equal((await queue.poll(UnknownBrowser, 1000).promise).length, 1);
	cancel();
});
