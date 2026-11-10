import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runCommand } from "../extension/commands.js";
import { CommandNames, ManifestStatus } from "../extension/daemon-link.js";
import { StdoutId } from "../extension/tap-link.js";
import { createTapReceiver } from "../extension/tap-receiver.js";
import { toJSONSafe } from "../extension/value-tags.js";

const ReloadDelay = 100;
const NotListening = "Could not establish connection. Receiving end does not exist.";
const QuietConsole = Object.fromEntries(Object.keys(console).map((key) => [key, () => {}]));

let loads = 0;
let worlds = 0;

	// a stand-in for Chrome with the stdout extension and one extension being
	// debugged, whose tap and the stdout extension's receiver talk for real.  each
	// gets its own ID, since the stdout extension only stores a registration once.
function createWorld(
	t)
{
	const tapId = `tap${++worlds}`;
	const world = {
		tapId,
		entries: [],
		echoed: [],
		events: [],
		stored: {},
		reloads: 0,
		tapListener: null,
		onReload: () => {},
	};
	const receive = createTapReceiver({
		storeEntry: async (entry) => world.entries.push(entry),
		console: {
			...QuietConsole,
			log: (...args) => world.echoed.push(["log", ...args]),
			warn: (...args) => world.echoed.push(["warn", ...args]),
		},
	});
		// extension messages arrive as JSON.  like Chrome, give up on an answer if
		// the listener doesn't send one right away or return true to send it later.
	const deliver = (handler, message, sender) => new Promise((resolve) => {
		if (handler(JSON.parse(JSON.stringify(message)), sender, resolve) !== true) {
			resolve(undefined);
		}
	});

	t.mock.timers.enable({ apis: ["setTimeout"] });
	globalThis.chrome = {
		runtime: {
			getManifest: () => ({ name: "Test" }),
			reload: () => {
				world.reloads++;
				world.onReload();
			},
			onMessageExternal: {
				addListener: (listener) => {
					world.events.push("listen");
					world.tapListener = listener;
				},
			},
			sendMessage: async (id, message) => {
				if (id === StdoutId) {
					world.events.push(message?.type);

					return deliver(receive, message, { id: tapId });
				}

				if (id === tapId && world.tapListener) {
					return deliver(world.tapListener, message, { id: StdoutId });
				}

				throw new Error(NotListening);
			},
		},
		storage: {
			local: {
				get: async () => ({ ...world.stored }),
				set: async (items) => Object.assign(world.stored, items),
			},
		},
		management: {
			getAll: async () => [{ id: tapId, name: "Test", installType: "development", enabled: true }],
			get: async () => ({ id: tapId, enabled: true, version: "1.0" }),
			setEnabled: async () => {},
		},
	};
	t.after(() => {
		delete globalThis.chrome;
		delete globalThis.ServiceWorkerGlobalScope;
	});

	return world;
}

	// stdout() only sets itself up once per module, so load a fresh copy of the
	// tap each time a page or worker of the debugged extension starts
async function startTap(
	world,
	{ worker })
{
	const realConsole = globalThis.console;

	world.tapListener = null;

	if (worker) {
		globalThis.ServiceWorkerGlobalScope = class {};
	} else {
		delete globalThis.ServiceWorkerGlobalScope;
	}

		// the tap also logs locally, which would clutter the test output
	globalThis.console = QuietConsole;

	try {
		const { default: stdout } = await import(`../lib/stdout.js?load=${++loads}`);

		return stdout({ id: StdoutId, filename: worker ? "sw.js" : "popup.html", wrapConsole: false });
	} finally {
		globalThis.console = realConsole;
	}
}

	// let everything waiting on promises catch up, then move the fake clock
async function advance(
	t,
	ms)
{
	for (let i = 0; i < 20; i++) {
		await nextTurn();
	}

	t.mock.timers.tick(ms);
}

	// keep the fake clock moving until a command finishes, so one that waits on
	// something that never happens fails instead of hanging
async function settle(
	t,
	promise)
{
	let done = false;

	promise.finally(() => done = true);

	for (let i = 0; i < 100 && !done; i++) {
		await advance(t, 1000);
	}

	assert.ok(done, "the command never finished");

	return promise;
}

const reload = (world) => runCommand({
	name: CommandNames.Reload,
	args: { extension: world.tapId, reloadManifest: true },
});

test("a tap's console call is stored and echoed by the stdout extension", async (t) => {
	const world = createWorld(t);
	const tap = await startTap(world, { worker: true });
	const map = new Map([[1, new Set(["a"])]]);

	tap.log("%s items", 2, map, undefined);
	await advance(t, 0);

	const [entry] = world.entries;

	assert.equal(world.entries.length, 1);
	assert.equal(entry.extensionId, world.tapId);
	assert.equal(entry.extensionName, "Test");
	assert.equal(entry.filename, "sw.js");
	assert.equal(entry.method, "log");
	assert.equal(typeof entry.loadId, "string");
	assert.equal(typeof entry.time, "number");
	assert.deepEqual(entry.args, JSON.parse(JSON.stringify(["%s items", 2, map, undefined].map((arg) => toJSONSafe(arg)))));

	const [method, format, ...rest] = world.echoed[0];

	assert.equal(method, "log");
	assert.match(format, /%c %s items$/);
	assert.deepEqual(rest.slice(-3), [2, map, undefined]);
	assert.equal(world.stored[`registered:${world.tapId}`], true);
});

test("a tap's errors are echoed as labeled warnings", async (t) => {
	const world = createWorld(t);
	const tap = await startTap(world, { worker: false });

	tap.error("broken");
	await advance(t, 0);

	assert.equal(world.entries[0].method, "error");
	assert.equal(world.echoed[0][0], "warn");
	assert.match(world.echoed[0][1], /^%cerror /);
	assert.equal(world.echoed[0].at(-1), "broken");
});

test("a worker's tap listens for reloads before it registers", async (t) => {
	const world = createWorld(t);

	await startTap(world, { worker: true });
	assert.deepEqual(world.events, ["listen", "register"]);
});

test("only a worker's tap listens for reloads", async (t) => {
	const world = createWorld(t);

	await startTap(world, { worker: false });
	assert.deepEqual(world.events, ["register"]);
	assert.equal(world.tapListener, null);
});

test("a tap reloads its extension once, however many times it's asked", async (t) => {
	const world = createWorld(t);

	await startTap(world, { worker: true });

	const answers = await Promise.all([
		chrome.runtime.sendMessage(world.tapId, { type: "reload" }),
		chrome.runtime.sendMessage(world.tapId, { type: "reload" }),
	]);

	await advance(t, ReloadDelay);
	assert.deepEqual(answers, [true, true]);
	assert.equal(world.reloads, 1);
});

test("a reload command sees the extension's worker start again", async (t) => {
	const world = createWorld(t);

	await startTap(world, { worker: true });
	world.onReload = () => startTap(world, { worker: true });

	const pending = reload(world);

	const { result } = await settle(t, pending);

	assert.equal(world.reloads, 1);
	assert.equal(result.manifest, ManifestStatus.Reloaded);
});

test("a popup starting during a reload isn't mistaken for the worker", async (t) => {
	const world = createWorld(t);

	await startTap(world, { worker: true });
		// the worker fails to start, but an open popup is reloaded with the extension
	world.onReload = () => startTap(world, { worker: false });

	const pending = reload(world);

	const { result } = await settle(t, pending);

	assert.equal(world.reloads, 1);
	assert.equal(result.manifest, ManifestStatus.Unconfirmed);
});

for (const [description, message] of [
	["a log entry without a type", { method: "log", args: ["hi"] }],
	["a log entry without args", { type: "log", method: "log", args: "hi" }],
	["a log entry without a method", { type: "log", args: ["hi"] }],
	["an unknown type", { type: "hello" }],
	["no message", null],
]) {
	test(`the stdout extension ignores ${description}`, async (t) => {
		const world = createWorld(t);
		const answer = await chrome.runtime.sendMessage(StdoutId, message);

		assert.equal(answer, false);
		assert.deepEqual(world.entries, []);
		assert.deepEqual(world.echoed, []);
		assert.deepEqual(world.stored, {});
	});
}
