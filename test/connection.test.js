import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionStatus, createDaemonConnection } from "../extension/connection.js";
import { BatchSize, CommandNames, createExtensionLink, LinkRoutes } from "../extension/link.js";
import { CommandQueue } from "../mcp/commands.js";
import { createExtensionRoutes } from "../mcp/extension-routes.js";
import { LogStore } from "../mcp/store.js";

const { Off, Looking, Connected } = ConnectionStatus;
const ShortPoll = 10;
const LongPoll = 5000;
	// long enough for a timer and a request to finish, given Windows' coarse timers
const SettleTime = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
	predicate)
{
	const deadline = Date.now() + 2000;

	while (!predicate()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${predicate}`);
		await sleep(1);
	}
}

function createDaemon(
	commandPollTime = ShortPoll)
{
	const store = new LogStore();
	const commands = new CommandQueue({ getCursor: () => store.getCursor() });

	return { store, commands, handle: createExtensionRoutes({ store, commands, commandPollTime }) };
}

/**
 * A real connection and Link talking to a real daemon's handling of the Extension
 * Link, with a buffer in memory.  Setting `daemon` to null makes requests fail,
 * and replacing it is a daemon restart.
 */
function setUp(
	t,
	{ delays, commandPollTime, runCommand = async () => ({ result: "ran" }) } = {})
{
	const world = {
		daemon: createDaemon(commandPollTime),
		agentMode: true,
		agentModeChecks: 0,
		buffer: [],
		statuses: [],
		requests: { [LinkRoutes.Ingest]: 0, [LinkRoutes.Commands]: 0, [LinkRoutes.CommandResult]: 0 },
		ingestsWithEntries: 0,
		failedRequests: 0,
		pollsInFlight: 0,
		mostPollsInFlight: 0,
		commandsRun: [],
			// set this to a promise to hold up ingest requests until it resolves
		gate: null,
		heldAtGate: 0,
	};

	async function respond(
		route,
		body)
	{
		world.requests[route]++;

		if (route === LinkRoutes.Ingest) {
			if (body.entries.length) {
				world.ingestsWithEntries++;
			}

			if (world.gate) {
				world.heldAtGate++;
				await world.gate;
			}
		}

		if (!world.daemon) {
			world.failedRequests++;
			throw new TypeError("Failed to fetch");
		}

		return world.daemon.handle(route, body, () => {});
	}

	const link = createExtensionLink({
		baseURL: "http://daemon",
		fetch: async (url, { body }) => {
			const route = new URL(url).pathname;
			const isPoll = route === LinkRoutes.Commands;

			if (isPoll) {
				world.mostPollsInFlight = Math.max(world.mostPollsInFlight, ++world.pollsInFlight);
			}

			try {
					// a real request always goes through the event loop
				await new Promise(setImmediate);

				return new Response(JSON.stringify(await respond(route, JSON.parse(body ?? "{}"))));
			} finally {
				if (isPoll) {
					world.pollsInFlight--;
				}
			}
		},
	});

	world.connection = createDaemonConnection({
		link,
		getBufferId: async () => "test",
		getEntriesAfter: async (position, limit) => world.buffer.filter(({ seq }) => seq > position).slice(0, limit),
		isAgentMode: async () => {
			world.agentModeChecks++;

			return world.agentMode;
		},
		runCommand: async (command) => {
			world.commandsRun.push(command);

			return runCommand(command);
		},
		onStatus: (status) => {
			world.statuses.push(status);
		},
		delays: { flush: 1, retryAfterFailure: 60 * 1000, fastRetry: 2, ...delays },
	});
	world.log = (count = 1) => {
		for (let i = 0; i < count; i++) {
			world.buffer.push({
				seq: world.buffer.length + 1,
				time: 1000,
				extensionId: "abc",
				extensionName: "Test Extension",
				filename: "sw.js",
				method: "log",
				args: ["message"],
			});
		}
	};
	world.storedCount = () => world.daemon.store.entries.length;
	world.connected = () => world.statuses.includes(Connected);

		// ends the command poll loop, without waiting for a long poll to time out
	t.after(() => {
		world.agentMode = false;
		world.daemon?.commands.poller?.([]);
	});

	return world;
}

async function setUpConnected(
	t,
	options)
{
	const world = setUp(t, options);

	world.connection.start();
	await waitFor(world.connected);

	return world;
}

test("start sends the backlog and reports that it's connected", async (t) => {
	const world = setUp(t);

	world.log(3);
	world.connection.start();
	await waitFor(() => world.storedCount() === 3);
	await waitFor(world.connected);

	assert.deepEqual(world.statuses, [Looking, Connected]);
});

test("a woken service worker reconnects without being started", async (t) => {
	const world = setUp(t);

	world.log();
	world.connection.checkIn();
	await waitFor(() => world.storedCount() === 1);
	await waitFor(world.connected);

	assert.deepEqual(world.statuses, [Connected]);
});

test("sends nothing when agent mode is off", async (t) => {
	const world = setUp(t);

	world.agentMode = false;
	world.log();
	await world.connection.checkIn();

	assert.equal(world.requests[LinkRoutes.Ingest], 0);
	assert.deepEqual(world.statuses, []);
});

test("sends the whole backlog before polling for commands", async (t) => {
	const world = setUp(t, { commandPollTime: LongPoll });
	const { promise } = world.daemon.commands.send(CommandNames.Reload, {}, 2000);

	world.log(BatchSize * 2 + 1);
	world.connection.start();

	const { result, cursor } = await promise;

	assert.equal(result, "ran");
	assert.equal(world.storedCount(), BatchSize * 2 + 1);
	assert.equal(cursor, world.daemon.store.getCursor());
});

test("runs commands and reports their results", async (t) => {
	const world = await setUpConnected(t, {
		commandPollTime: LongPoll,
		runCommand: async ({ args }) => ({ result: args.value * 2 }),
	});
	const { promise } = world.daemon.commands.send("double", { value: 21 }, 2000);

	assert.equal((await promise).result, 42);
});

test("batches a burst of entries into one request", async (t) => {
	const world = await setUpConnected(t);

	world.log(3);
	world.connection.entryAdded();
	world.connection.entryAdded();
	world.connection.entryAdded();
	await waitFor(() => world.storedCount() === 3);

	assert.equal(world.ingestsWithEntries, 1);
});

test("coalesces check-ins that arrive during a sync into one more sync", async (t) => {
	const world = await setUpConnected(t);
	let release;

	world.gate = new Promise((resolve) => {
		release = resolve;
	});

	const requestsBefore = world.requests[LinkRoutes.Ingest];

	world.connection.checkIn();
	await waitFor(() => world.heldAtGate === 1);
	world.log();
	world.connection.checkIn();
	world.connection.checkIn();
	world.connection.checkIn();
	world.gate = null;
	release();
	await waitFor(() => world.storedCount() === 1);
	await sleep(SettleTime);

	assert.equal(world.requests[LinkRoutes.Ingest] - requestsBefore, 2);
});

test("resends everything to a restarted daemon", async (t) => {
	const world = await setUpConnected(t);

	world.log(3);
	world.connection.entryAdded();
	await waitFor(() => world.storedCount() === 3);

	world.daemon = createDaemon();
	world.log();
	world.connection.entryAdded();
	await waitFor(() => world.storedCount() === 4);
});

test("keeps looking for the daemon after it starts", async (t) => {
	const world = setUp(t);

	world.daemon = null;
	world.log();
	world.connection.start();
	await waitFor(() => world.failedRequests >= 2);
	assert.ok(!world.connected());

	world.daemon = createDaemon();
	await waitFor(world.connected);
	await waitFor(() => world.storedCount() === 1);
});

test("stops looking quickly once it's connected", async (t) => {
	const world = await setUpConnected(t);
	const requests = world.requests[LinkRoutes.Ingest];

	await sleep(20);

	assert.equal(world.requests[LinkRoutes.Ingest], requests);
});

test("stops looking quickly at the deadline", async (t) => {
	const world = setUp(t, { delays: { fastRetryDuration: 20 } });

	world.daemon = null;
	world.connection.start();
	await sleep(60);

	const failures = world.failedRequests;

	assert.ok(failures > 0);
	await sleep(20);
	assert.equal(world.failedRequests, failures);
});

test("new entries don't retry right after a failure, but a check-in does", async (t) => {
	const world = setUp(t, { delays: { fastRetryDuration: 0 } });

	world.daemon = null;
	await world.connection.checkIn();
	assert.equal(world.failedRequests, 1);
	assert.deepEqual(world.statuses, [Looking]);

	world.log();
	world.connection.entryAdded();
	await sleep(SettleTime);
	assert.equal(world.failedRequests, 1);

	await world.connection.checkIn();
	assert.equal(world.failedRequests, 2);

	world.daemon = createDaemon();
	await world.connection.checkIn();
	assert.equal(world.statuses.at(-1), Connected);
	await waitFor(() => world.storedCount() === 1);

	world.log();
	world.connection.entryAdded();
	await waitFor(() => world.storedCount() === 2);
});

test("new entries retry once the failure is old enough", async (t) => {
	const world = setUp(t, { delays: { retryAfterFailure: 10 } });

	world.daemon = null;
	await world.connection.checkIn();
	await sleep(20);
	world.connection.entryAdded();
	await waitFor(() => world.failedRequests === 2);
});

for (const [name, finishRequest] of [
	["succeeds", () => {}],
	["fails", (world) => {
		world.daemon = null;
	}],
]) {
	test(`ignores a sync that ${name} after agent mode was turned off`, async (t) => {
		const world = setUp(t);
		let release;

		world.gate = new Promise((resolve) => {
			release = resolve;
		});
		world.connection.checkIn();
		await waitFor(() => world.heldAtGate === 1);

		world.agentMode = false;
		await world.connection.stop();
		finishRequest(world);
		release();
		await sleep(SettleTime);

		assert.deepEqual(world.statuses, [Off]);
		assert.equal(world.requests[LinkRoutes.Commands], 0);
	});
}

test("sends only what's new after being turned off and on", async (t) => {
	const world = await setUpConnected(t);

	world.log(2);
	world.connection.entryAdded();
	await waitFor(() => world.storedCount() === 2);

	world.agentMode = false;
	await world.connection.stop();
	world.statuses.length = 0;
	world.log();

	world.agentMode = true;
	world.connection.start();
	await waitFor(() => world.storedCount() === 3);
	await waitFor(world.connected);

	assert.deepEqual(world.statuses, [Looking, Connected]);
});

test("stops polling for commands when agent mode is off", async (t) => {
	const world = await setUpConnected(t);

	await waitFor(() => world.requests[LinkRoutes.Commands] > 1);
	world.agentMode = false;
	await sleep(ShortPoll * 2);

	const polls = world.requests[LinkRoutes.Commands];

	await sleep(ShortPoll * 3);
	assert.equal(world.requests[LinkRoutes.Commands], polls);
});

test("checks agent mode before every command poll, which keeps the worker awake", async (t) => {
	const world = await setUpConnected(t);

	await waitFor(() => world.requests[LinkRoutes.Commands] >= 5);

	assert.ok(world.agentModeChecks >= world.requests[LinkRoutes.Commands]);
});

test("runs only one command poll at a time", async (t) => {
	const world = await setUpConnected(t);

	await world.connection.checkIn();
	await world.connection.checkIn();
	await waitFor(() => world.requests[LinkRoutes.Commands] >= 3);
		// give any extra poll loop time to reach the daemon
	await sleep(ShortPoll);

	assert.equal(world.mostPollsInFlight, 1);
});

test("refuses a command that arrives after agent mode was turned off", async (t) => {
	const world = await setUpConnected(t, { commandPollTime: LongPoll });

	await waitFor(() => world.daemon.commands.poller);
	world.agentMode = false;

	const { promise } = world.daemon.commands.send(CommandNames.Reload, {}, 2000);
	const outcome = await promise;

	assert.match(outcome.error, /turned off/);
	assert.deepEqual(world.commandsRun, []);
});

test("a failed command poll waits for the next sync to change anything", async (t) => {
	const world = await setUpConnected(t);

	await waitFor(() => world.requests[LinkRoutes.Commands] > 0);
	world.daemon = null;
	await waitFor(() => world.failedRequests > 0);
	await sleep(ShortPoll * 2);
	assert.equal(world.statuses.at(-1), Connected);

	const polls = world.requests[LinkRoutes.Commands];

	await sleep(ShortPoll * 2);
	assert.equal(world.requests[LinkRoutes.Commands], polls);

	world.daemon = createDaemon(LongPoll);

	const { promise } = world.daemon.commands.send(CommandNames.Reload, {}, 2000);

	await world.connection.checkIn();
	assert.equal((await promise).result, "ran");
});
