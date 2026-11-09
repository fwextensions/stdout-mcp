import { handleAlarm, handleEntryAdded, handleStorageChange, restoreAgentMode, toggleAgentMode } from "./agent-mode.js";
import { addEntry } from "./buffer.js";
import { notifyRegistered, registerExtension } from "./commands.js";
import { fromJSONSafe } from "./deserialize.js";

const FilenameStyle = "color: light-dark(#aaa, #888)";
const ResetStyle = "color: initial";
const ErrorLabelStyle = "color: light-dark(#c00, #f66); font-weight: bold";
	// ignore %%, which escapes the % character
const SubstitutionPattern = /%[^%]/;

const senderIDs = new Set();

function handleMessage(
	message,
	sender,
	sendResponse)
{
	const { type, method, filename, args, time = Date.now(), name, loadId } = message;

	registerExtension(sender.id);

	if (type === "register") {
		notifyRegistered(sender);
		sendResponse(true);

		return;
	}

	senderIDs.add(sender.id);

	if (!Array.isArray(args)) {
		sendResponse(false);

		return;
	}

		// store every message, whether or not agent mode is on, so that an agent
		// can see what happened before it connected.  the args arrive as JSON, so
		// they can be stored and sent on as is.
	addEntry({
		time,
		extensionId: sender.id,
		extensionName: name,
		filename,
		loadId,
		method,
		args,
	})
		.then(handleEntryAdded)
		.catch((error) => console.error("stdout: couldn't store log entry", error));

	if (typeof console[method] === "function") {
		const [firstArg, ...rest] = args;
		const senderInfo = (senderIDs.size > 1 ? sender.id.slice(0, 4) + " " : "") + filename;
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

		// if we don't call sendResponse(), Chrome will keep the calling service worker
		// alive waiting for a response, up to 5 minutes.  sending the response here
		// lets the service worker get terminated after 30 seconds.
	sendResponse(true);
}

chrome.runtime.onMessageExternal.addListener(handleMessage);
chrome.action.onClicked.addListener(toggleAgentMode);
chrome.storage.onChanged.addListener(handleStorageChange);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.runtime.onStartup.addListener(restoreAgentMode);
chrome.runtime.onInstalled.addListener(restoreAgentMode);
