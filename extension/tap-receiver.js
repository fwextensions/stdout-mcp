import { notifyWorkerStarted, registerExtension } from "./commands.js";
import { fromJSONSafe } from "./deserialize.js";
import { readTapMessage, TapMessageType } from "./tap-link.js";

const FilenameStyle = "color: light-dark(#aaa, #888)";
const ResetStyle = "color: initial";
const ErrorLabelStyle = "color: light-dark(#c00, #f66); font-weight: bold";
	// ignore %%, which escapes the % character
const SubstitutionPattern = /%[^%]/;

/**
 * Echo a tap's console call in this extension's console, labeled with where it
 * came from.
 */
function echo(
	console,
	{ method, args, filename },
	senderInfo)
{
	if (typeof console[method] !== "function") {
		return;
	}

	const [firstArg, ...rest] = args;
		// Chrome lists console.error() calls on chrome://extensions as errors in
		// this extension, so show other extensions' errors as labeled warnings
	const isError = method === "error";
	const label = isError
		? ["%cerror %c%s", ErrorLabelStyle, FilenameStyle, senderInfo]
		: ["%c%s", FilenameStyle, senderInfo];
	let outputArgs = [...label, ...args.map(fromJSONSafe)];

	if (SubstitutionPattern.test(firstArg) && rest.length) {
			// firstArg contains a string substitution and there are additional args
			// that can be substituted in.  (a string with a % in it but no following
			// args, like "Pct light speed (%c)", wouldn't trigger a substitution.)
			// that firstArg has to be in the first argument to work, so add a style
			// reset substitution to our initial string (the second %c) and then
			// concat the first arg from the message.  then pass in the filename
			// style, the filename, and the reset style, and finally the rest of
			// the message args.
		outputArgs = [
			label[0] + "%c " + firstArg,
			...label.slice(1),
			ResetStyle,
			...rest.map(fromJSONSafe)
		];
	}

	console[isError ? "warn" : method](...outputArgs);
}

/**
 * Create the stdout extension's end of the Tap Link, which handles what taps
 * send it.
 *
 * @param {object} options
 * @param {(entry: object) => Promise<any>} options.storeEntry  Saves a log entry
 * in the buffer.
 * @param {Console} [options.console]  Where to echo the taps' console calls.
 * @returns {(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: boolean) => void) => void}
 * A listener for `chrome.runtime.onMessageExternal`.
 */
export function createTapReceiver(
	{ storeEntry, console = globalThis.console })
{
	const senderIDs = new Set();

	return function handleTapMessage(
		rawMessage,
		sender,
		sendResponse)
	{
		const message = readTapMessage(rawMessage);

		if (message?.type === TapMessageType.Register) {
			registerExtension(sender.id);

			if (message.worker) {
				notifyWorkerStarted(sender.id);
			}

			sendResponse(true);

			return;
		}

		if (message?.type !== TapMessageType.Log) {
			sendResponse(false);

			return;
		}

		const { time, name, filename, loadId, method, args } = message;

		registerExtension(sender.id);
		senderIDs.add(sender.id);

			// store every message, whether or not agent mode is on, so that an agent
			// can see what happened before it connected.  the args arrive as JSON, so
			// they can be stored and sent on as is.
		storeEntry({
			time,
			extensionId: sender.id,
			extensionName: name,
			filename,
			loadId,
			method,
			args,
		})
			.catch((error) => console.error("stdout: couldn't store log entry", error));

		echo(console, message, (senderIDs.size > 1 ? sender.id.slice(0, 4) + " " : "") + filename);

			// if we don't call sendResponse(), Chrome will keep the calling service worker
			// alive waiting for a response, up to 5 minutes.  sending the response here
			// lets the service worker get terminated after 30 seconds.
		sendResponse(true);
	};
}
