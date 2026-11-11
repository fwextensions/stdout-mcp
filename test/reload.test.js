import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { notifyWorkerStarted, runCommand } from "../extension/commands.js";
import { CommandNames, CommandRunSeconds, ManifestStatus } from "../extension/daemon-link.js";

const ID = "abc";
const WakeTimeout = 5 * 1000;
const RestartTimeout = 10 * 1000;

	// a stand-in for Chrome and one unpacked extension.  the first message to a
	// sleeping worker always fails, since its listener doesn't exist yet.
function installChrome(
	t,
	{
		awake = false,
		wakes = false,
		answersAfterWake = true,
		registersBeforeFailing = false,
		firstAskHangs = false,
		registersBeforeAnswering = false,
		answersAfterRestart = true,
		registersAfterRestart = true,
		restartDelay = 0,
		togglingHangs = false,
	} = {})
{
	const calls = { asks: 0, toggles: [] };
	let listening = awake;
	let woken = false;
	let reloading = false;

	const wake = (id) => {
		listening = answersAfterWake;
		notifyWorkerStarted(id);
	};

		// never let the answer and restart timers run for real
	t.mock.timers.enable({ apis: ["setTimeout"] });
	globalThis.chrome = {
		management: {
			getAll: async () => [{ id: ID, name: "Test", installType: "development", enabled: true }],
			get: async () => ({ id: ID, enabled: true, version: "1.2.3" }),
			setEnabled: async (id, enabled) => {
				calls.toggles.push(enabled);

				if (togglingHangs) {
					return new Promise(() => {});
				}

				listening = enabled && answersAfterRestart;

				if (enabled && registersAfterRestart) {
					nextTurn().then(() => notifyWorkerStarted(id));
				}
			},
		},
		storage: { local: { get: async () => ({ [`registered:${ID}`]: true }) } },
		runtime: {
			sendMessage: async (id, message) => {
				assert.deepEqual(message, { type: "reload" });
				calls.asks++;

				if (firstAskHangs && calls.asks === 1) {
					nextTurn().then(() => wake(id));

					return new Promise(() => {});
				}

				if (registersBeforeAnswering && calls.asks === 1) {
					notifyWorkerStarted(id);
				}

				if (!listening) {
					if (wakes && !woken) {
						woken = true;

						if (registersBeforeFailing) {
							wake(id);
						} else {
							nextTurn().then(() => wake(id));
						}
					}

					throw new Error("Could not establish connection. Receiving end does not exist.");
				}

					// like a tap, only reload once however many times we're asked
				if (!reloading) {
					reloading = true;

					if (restartDelay) {
						setTimeout(() => notifyWorkerStarted(id), restartDelay);
					} else {
						nextTurn().then(() => notifyWorkerStarted(id));
					}
				}

				return true;
			},
		},
	};
	t.after(() => delete globalThis.chrome);

	return calls;
}

const reload = (reloadManifest) => runCommand({
	name: CommandNames.Reload,
	args: { extension: ID, reloadManifest },
});

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

test("asks an awake worker to reload, without restarting it first", async (t) => {
	const calls = installChrome(t, { awake: true });
	const { result } = await reload(true);

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(result.version, "1.2.3");
	assert.equal(calls.asks, 1);
	assert.deepEqual(calls.toggles, []);
});

test("asks again once a sleeping worker wakes and registers, without a restart", async (t) => {
	const calls = installChrome(t, { wakes: true });
	const { result } = await reload(true);

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(calls.asks, 2);
	assert.deepEqual(calls.toggles, []);
});

test("doesn't miss a worker that registers before the first ask fails", async (t) => {
	const calls = installChrome(t, { wakes: true, registersBeforeFailing: true });
	const { result } = await reload(true);

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(calls.asks, 2);
	assert.deepEqual(calls.toggles, []);
});

test("asks again as soon as the worker registers, even if the first ask hasn't finished", async (t) => {
	const calls = installChrome(t, { firstAskHangs: true });
	const { result } = await reload(true);

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(calls.asks, 2);
	assert.deepEqual(calls.toggles, []);
});

test("still confirms the restart when a worker registers and answers the first ask", async (t) => {
	const calls = installChrome(t, { awake: true, registersBeforeAnswering: true });
	const { result } = await reload(true);

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(calls.asks, 2);
	assert.deepEqual(calls.toggles, []);
});

test("restarts a worker that wakes but can't answer, then asks again", async (t) => {
	const calls = installChrome(t, { wakes: true, answersAfterWake: false });
	const { result } = await reload(true);

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(calls.asks, 3);
	assert.deepEqual(calls.toggles, [false, true]);
});

test("restarts a worker that doesn't wake, then asks again", async (t) => {
	const calls = installChrome(t);
	const pending = reload(true);

	await advance(t, WakeTimeout);

	const { result } = await pending;

	assert.equal(result.manifest, ManifestStatus.Reloaded);
	assert.equal(calls.asks, 2);
	assert.deepEqual(calls.toggles, [false, true]);
});

test("reports an extension that restarts but still doesn't answer", async (t) => {
	const calls = installChrome(t, { answersAfterRestart: false });
	const pending = reload(true);

	await advance(t, WakeTimeout);

	const { result } = await pending;

	assert.equal(result.manifest, ManifestStatus.Unreachable);
	assert.equal(calls.asks, 2);
	assert.deepEqual(calls.toggles, [false, true]);
});

test("doesn't ask again when the worker never starts", async (t) => {
	const calls = installChrome(t, { registersAfterRestart: false });
	const pending = reload(true);

	await advance(t, WakeTimeout);
	await advance(t, RestartTimeout);

	const { result } = await pending;

	assert.equal(result.manifest, ManifestStatus.Unreachable);
	assert.equal(calls.asks, 1);
	assert.deepEqual(calls.toggles, [false, true]);
});

test("only restarts the extension when the manifest isn't wanted", async (t) => {
	const calls = installChrome(t, { awake: true });
	const { result } = await reload(false);

	assert.equal(result.manifest, ManifestStatus.Skipped);
	assert.equal(calls.asks, 0);
	assert.deepEqual(calls.toggles, [false, true]);
});

test("tells two reloads of the same extension at once that it restarted", async (t) => {
	installChrome(t, { awake: true, restartDelay: 100 });

	const pending = Promise.all([reload(true), reload(true)]);

	await advance(t, 100);
	await advance(t, RestartTimeout);

	const results = await pending;

	assert.deepEqual(results.map(({ result }) => result.manifest), [ManifestStatus.Reloaded, ManifestStatus.Reloaded]);
});

test("answers before the daemon gives up, even if a command is still running", async (t) => {
	installChrome(t, { togglingHangs: true });

	const pending = reload(false);
	let answer;

	pending.then((result) => answer = result);
	await advance(t, (CommandRunSeconds - 3) * 1000);
	assert.equal(answer, undefined);
	await advance(t, 1000);

	const { error } = await pending;

	assert.match(error, /couldn't finish the reload command within 38 seconds.*may still finish/s);
	assert.ok(38 < CommandRunSeconds);
});

test("says when it doesn't know a command", async () => {
	assert.match((await runCommand({ name: "toString", args: {} })).error, /doesn't know the "toString" command/);
});