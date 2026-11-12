import { createLogMessage, createRegisterMessage, readTapMessage, StdoutId, TapMessageType } from "../extension/tap-link.js";

export { toJSONSafe } from "../extension/value-tags.js";

const _console = console;
const noop = () => {};
const ReloadDelay = 100;
let methods;

/**
 * @typedef {object} StdoutOptions
 *
 * @property {boolean} [enabled]  Whether to send console output to the `stdout`
 * extension.  Defaults to `true`.  When `false`, `stdout()` silently does nothing,
 * so you can use an environment variable or something similar to turn log
 * forwarding off in production.
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
 * @param {StdoutOptions} [options]
 *
 * @returns {typeof console}
 */
export default function stdout(
	options)
{
	const {
		enabled = true,
		filename = location.pathname.split("/").pop(),
		wrapConsole = true,
	} = options ?? {};

	if (!enabled) {
		return _console;
	}

	if (methods) {
			// only generate the methods once, even if we're called multiple times
		return methods;
	}

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
			if (sender.id === StdoutId && readTapMessage(message)?.type === TapMessageType.Reload) {
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
	chrome.runtime.sendMessage(StdoutId, createRegisterMessage(isWorker)).then(noop, noop);

		// wrap all the console methods in the local extension to send the arguments
		// passed to them onto the stdout extension, where they can be viewed in the
		// service worker console
	methods = Object.keys(console)
		.filter((key) => typeof console[key] === "function")
		.reduce((result, method) => ({
			...result,
			[method](...args) {
				try {
					chrome.runtime.sendMessage(StdoutId, createLogMessage({ method, args, filename, name, loadId }))
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
