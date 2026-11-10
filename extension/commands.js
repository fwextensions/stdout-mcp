import { CommandNames, ManifestStatus } from "./daemon-link.js";

const RegisteredPrefix = "registered:";
	// waking a service worker can take a moment
const ReloadAnswerTimeout = 5 * 1000;
const RestartTimeout = 10 * 1000;
const WakeTimeout = 5 * 1000;

	// avoids writing to storage for every message once a sender is recorded
const registeredIDs = new Set();
const restartWaiters = new Map();

/**
 * Remember an extension that has called stdout(), since only those can be
 * reloaded by an agent.  Each one gets its own key, so that extensions
 * registering at the same time can't overwrite each other.
 */
export function registerExtension(
	id)
{
	if (registeredIDs.has(id)) {
		return;
	}

	registeredIDs.add(id);
	chrome.storage.local.set({ [RegisteredPrefix + id]: true })
		.catch((error) => {
			registeredIDs.delete(id);
			console.error("stdout: couldn't register extension", error);
		});
}

/**
 * Note that a registering extension has started, which is how we can tell that
 * a full reload worked.  Content scripts in open tabs register whenever a page
 * loads, so those don't count.
 */
export function notifyRegistered(
	{ id, tab })
{
	if (!tab) {
		restartWaiters.get(id)?.(true);
	}
}

function waitForRestart(
	id,
	timeout = RestartTimeout)
{
	return new Promise((resolve) => {
		const finish = (restarted) => {
			clearTimeout(timer);
			restartWaiters.delete(id);
			resolve(restarted);
		};
		const timer = setTimeout(() => finish(false), timeout);

		restartWaiters.set(id, finish);
	});
}

	// the extension only answers if its service worker can run and it's using a
	// version of the library that handles this message
async function askToReload(
	id)
{
	const timeout = new Promise((resolve) => setTimeout(resolve, ReloadAnswerTimeout, false));

	try {
		return await Promise.race([chrome.runtime.sendMessage(id, { type: "reload" }), timeout]) === true;
	} catch {
		return false;
	}
}

	// our message wakes a sleeping worker, but it fails if the worker hasn't
	// called stdout() by the time Chrome delivers it, such as when stdout() runs
	// after a top-level await.  the worker keeps starting, so ask again as soon as
	// it registers, without waiting on the first ask, which may not fail right
	// away.  start waiting before that ask, since the worker can register first.
async function askWorkerToReload(
	id)
{
	const registered = waitForRestart(id, WakeTimeout);
	const answered = askToReload(id);
		// a failed ask says nothing about the worker, so keep waiting for it to register
	const outcome = await Promise.race([
		registered,
		answered.then((didAnswer) => didAnswer ? "answered" : registered),
	]);

	if (outcome === "answered") {
		restartWaiters.get(id)?.(false);

		return true;
	}

	return outcome && askToReload(id);
}

async function confirmFullReload(
	id)
{
	const restarted = await waitForRestart(id);
	const installed = await chrome.management.get(id).catch(() => null);

	if (!installed?.enabled) {
		return { manifest: ManifestStatus.Failed };
	}

	return { manifest: restarted ? ManifestStatus.Reloaded : ManifestStatus.Unconfirmed, version: installed.version };
}

async function findExtension(
	extension)
{
	const [installed, stored] = await Promise.all([
		chrome.management.getAll(),
		chrome.storage.local.get(null),
	]);
	const registered = installed.filter(({ id }) => stored[RegisteredPrefix + id]);
	const nameLower = extension.toLowerCase();
	const matches = registered.filter(({ id, name }) => id === extension || name.toLowerCase() === nameLower);

	if (matches.length > 1) {
		throw new Error(`More than one extension is named "${extension}". Use one of these IDs instead: `
			+ matches.map(({ id }) => id).join(", "));
	}

	if (!matches.length) {
		const names = registered.map(({ id, name }) => `${name} (${id})`).join(", ");

		throw new Error(`No extension with that name or ID has called stdout(). `
			+ (names ? `These can be reloaded: ${names}.` : "No extensions have called it yet."));
	}

	return matches[0];
}

async function reloadExtension(
	{ extension, reloadManifest })
{
	const { id, name, installType, enabled } = await findExtension(extension);

	if (installType !== "development") {
		throw new Error(`${name} isn't an unpacked extension, so it can't be reloaded.`);
	}

	if (!enabled) {
		throw new Error(`${name} is turned off in Chrome, so it can't be reloaded. Ask the user to turn it on.`);
	}

	if (reloadManifest && await askWorkerToReload(id)) {
		return { id, name, ...await confirmFullReload(id) };
	}

		// turning an unpacked extension off and on runs its code again from disk.
		// Chrome keeps the manifest it already read, though.
	await chrome.management.setEnabled(id, false);

		// wait until the old worker is gone, so that only the new one can count.
		// if the message above didn't get an answer, this restart may still leave a
		// worker that can give one.
	const restarted = reloadManifest && waitForRestart(id);

	await chrome.management.setEnabled(id, true);

	if (await restarted && await askToReload(id)) {
		return { id, name, ...await confirmFullReload(id) };
	}

	return { id, name, manifest: reloadManifest ? ManifestStatus.Unreachable : ManifestStatus.Skipped };
}

const Commands = {
	[CommandNames.Reload]: reloadExtension,
};

/**
 * @returns {Promise<{ result?: any, error?: string }>}
 */
export async function runCommand(
	{ name, args })
{
	try {
		return { result: await Commands[name](args) };
	} catch (error) {
		return { error: error.message };
	}
}
