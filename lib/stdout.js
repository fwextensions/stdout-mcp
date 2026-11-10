import { createLogMessage, createRegisterMessage, readTapMessage, StdoutId, TapMessageType } from "../extension/tap-link.js";

export { toJSONSafe } from "../extension/value-tags.js";

/**
 * The ID of the unpacked `stdout` extension.  It's fixed by the `key` in the
 * extension's manifest, so it's the same wherever the extension is installed.
 */
export const STDOUT_ID = StdoutId;

const _console = console;
const noop = () => {};
const ReloadDelay = 100;
let methods;

/**
 * @typedef {object} StdoutOptions
 *
 * @property {string} [id]  The id of the `stdout` extension (like `"obca..."`),
 * which will depend on where the unpacked extension is installed on your system.
 * Passing an empty or undefined ID will cause `stdout()` to silently do nothing,
 * so you can use an environment variable or something similar to sometimes
 * enable log forwarding and sometimes not.
 *
 * @property {boolean} [wrapConsole]  Whether to wrap the global `console` object
 * with methods that forward all calls to the `stdout` extension.
 *
 * @property {string} [filename]  The name of the current extension page.  Defaults
 * to the last segment of `location.pathname`.
 */

/**
 * Wrap the local `console` object with methods that forward all calls to the
 * `stdout` extension.  This lets you view the console output in the `stdout`
 * devtools window without having to keep your own extension's devtools active.
 * The output will also be sent to your extension's console, in case it's open.
 *
 * @param {string|StdoutOptions} [options] - Either the ID of the `stdout`
 * extension or an options object that contains the `id` and other options.
 *
 * @returns {typeof console}
 */
export default function stdout(
	options)
{
	if (!options || (typeof options !== "string" && !options.id)) {
		return _console;
	}

	if (methods) {
			// only generate the methods once, even if we're called multiple times
		return methods;
	}

	if (typeof options === "string") {
		options = { id: options };
	}

	const {
		id,
		filename = location.pathname.split("/").pop(),
		wrapConsole = true,
	} = options;
		// identify this extension in the logs that coding agents read
	const name = chrome.runtime.getManifest?.().name;
		// identify this page load, so agents can tell when a service worker restarts
		// or a popup is reopened.  crypto.randomUUID() isn't available to content
		// scripts on http: pages.
	const loadId = Date.now().toString(36) + Math.random().toString(36).slice(2);

		// let an agent reload this extension, including its manifest.  only the
		// service worker listens, so that open pages don't also respond.  add this
		// before registering below, since the stdout extension may ask us to reload
		// as soon as it hears from us.
	const isWorker = "ServiceWorkerGlobalScope" in globalThis;

	if (isWorker) {
		let reloading = false;

		chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
			if (sender.id === id && readTapMessage(message)?.type === TapMessageType.Reload) {
				sendResponse(true);

					// the stdout extension can ask twice while this worker is waking up
				if (!reloading) {
					reloading = true;
						// give the response time to get back to the stdout extension
					setTimeout(() => chrome.runtime.reload(), ReloadDelay);
				}
			}
		});
	}

		// tell the stdout extension about this one, so a coding agent can reload it
		// even if it hasn't logged anything.  a worker registering also tells it
		// that a reload worked.
	chrome.runtime.sendMessage(id, createRegisterMessage(isWorker)).then(noop, noop);

		// wrap all the console methods in the local extension to send the arguments
		// passed to them onto the stdout extension, where they can be viewed in the
		// service worker console
	methods = Object.keys(console)
		.filter((key) => typeof console[key] === "function")
		.reduce((result, method) => ({
			...result,
			[method](...args) {
				try {
					chrome.runtime.sendMessage(id, createLogMessage({ method, args, filename, name, loadId }))
							// suppress any runtime.lastError messages, such as when
							// the stdout extension is not installed
						.then(noop, noop);
				} catch {
						// don't let a value that can't be sent, like an object with a
						// throwing getter, break the caller's logging
				}

					// log the message locally as well
				_console[method](...args);
			}
				// every console method gets wrapped, so this ends up a whole Console
		}), /** @type {Console} */ ({}));

	if (wrapConsole) {
		globalThis.console = methods;
	}

	return methods;
}
