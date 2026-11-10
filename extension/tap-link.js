// @ts-check
import { toJSONSafe } from "./value-tags.js";

// The Tap Link: the conversation between a tap, which runs inside an extension
// being debugged, and the stdout extension.  It lives here because an unpacked
// extension can't import anything outside its own folder, and the tap imports
// it from here, so it can't use Chrome or Node APIs.

/**
 * The ID of the unpacked stdout extension.  It's fixed by the `key` in the
 * extension's manifest, so it's the same wherever the extension is installed.
 */
export const StdoutId = "lnkfeennpkaoelponfafleomlmgjfjok";

export const TapMessageType = {
		// sent by the tap when it starts, so the extension can be reloaded even
		// if it hasn't logged anything
	Register: "register",
		// sent by the tap for each console call
	Log: "log",
		// sent by the stdout extension to ask a tap's service worker to reload
		// the whole extension
	Reload: "reload",
};

/**
 * @typedef {object} RegisterMessage
 * @property {"register"} type
 * @property {boolean} worker  Whether it came from the extension's service
 * worker, which means the extension just started.
 */

/**
 * @typedef {object} LogMessage
 * @property {"log"} type
 * @property {string} method  The console method, like "error".
 * @property {any[]} args  The arguments, converted to value tags where JSON
 * can't carry them.
 * @property {number} time
 * @property {string} [filename]  The page or script that logged it.
 * @property {string} [name]  The extension's name.
 * @property {string} [loadId]  Identifies the page load, so agents can tell when
 * a service worker restarts or a popup is reopened.
 */

/**
 * @typedef {object} ReloadMessage
 * @property {"reload"} type
 */

/**
 * @param {boolean} worker
 * @returns {RegisterMessage}
 */
export function createRegisterMessage(
	worker)
{
	return { type: "register", worker };
}

/**
 * @param {{ method: string, args: any[], filename?: string, name?: string, loadId?: string }} call
 * @returns {LogMessage}
 */
export function createLogMessage(
	{ method, args, filename, name, loadId })
{
	return {
		type: "log",
		method,
		filename,
		name,
		loadId,
		time: Date.now(),
		args: args.map((arg) => toJSONSafe(arg)),
	};
}

/**
 * @returns {ReloadMessage}
 */
export function createReloadMessage()
{
	return { type: "reload" };
}

const optionalString = (value) => typeof value === "string" ? value : undefined;

/**
 * Check a message that arrived over the Tap Link.  Anything else Chrome delivers
 * from another extension is ignored.
 *
 * @param {any} message
 * @returns {RegisterMessage|LogMessage|ReloadMessage|null} The message, or null if
 * it isn't one we understand.
 */
export function readTapMessage(
	message)
{
	switch (message?.type) {
		case TapMessageType.Register:
			return { type: "register", worker: message.worker === true };

		case TapMessageType.Log: {
			const { method, args, time, filename, name, loadId } = message;

			if (typeof method !== "string" || !Array.isArray(args)) {
				return null;
			}

			return {
				type: "log",
				method,
				args,
				time: Number.isFinite(time) ? time : Date.now(),
				filename: optionalString(filename),
				name: optionalString(name),
				loadId: optionalString(loadId),
			};
		}

		case TapMessageType.Reload:
			return { type: "reload" };
	}

	return null;
}
