import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandQueue } from "../mcp/commands.js";

const createQueue = () => new CommandQueue({ getCursor: () => "now" });

test("delivers a command to a waiting poll and returns its outcome", async () => {
	const queue = createQueue();
	const { promise: polled } = queue.poll(1000);
	const { promise } = queue.send("reload", { extension: "a" }, 1000);
	const [command] = await polled;

	assert.deepEqual(command, { id: 1, name: "reload", args: { extension: "a" } });
	queue.complete(command.id, { result: "done" });
	assert.deepEqual(await promise, { result: "done", cursor: "now" });
});

test("holds a command until the next poll", async () => {
	const queue = createQueue();
	const { cancel } = queue.send("reload", {}, 1000);
	const { promise } = queue.poll(1000);

	assert.equal((await promise).length, 1);
	cancel();
});

test("a poll returns nothing when its time is up", async () => {
	assert.deepEqual(await createQueue().poll(1).promise, []);
});

test("a new poll replaces an old one", async () => {
	const queue = createQueue();
	const first = queue.poll(1000);
	const second = queue.poll(1000);

	assert.deepEqual(await first.promise, []);

	const { cancel } = queue.send("reload", {}, 1000);

	assert.equal((await second.promise).length, 1);
	cancel();
});

test("a command that timed out or was cancelled never reaches the extension", async () => {
	const queue = createQueue();

	assert.deepEqual(await queue.send("reload", {}, 1).promise, { timedOut: true });

	const { promise, cancel } = queue.send("reload", {}, 1000);

	cancel();
	assert.deepEqual(await promise, { cancelled: true });
	assert.deepEqual(await queue.poll(1).promise, []);
});

test("takes the cursor when a command is picked up, not when it's queued", async () => {
	let cursor = "when queued";
	const queue = new CommandQueue({ getCursor: () => cursor });
	const { promise } = queue.send("reload", {}, 1000);

	cursor = "when picked up";

	const [command] = await queue.poll(1000).promise;

	cursor = "when answered";
	queue.complete(command.id, { result: "done" });
	assert.equal((await promise).cursor, "when picked up");
});
