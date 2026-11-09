// @ts-check
import { LinkRoutes } from "../extension/link.js";

	// Chrome shuts down a service worker whose fetch takes more than 30 seconds
const DefaultCommandPollTime = 25 * 1000;

export const ExtensionRoutes = new Set(Object.values(LinkRoutes));

/**
 * The daemon's half of the Extension Link.  The caller is responsible for HTTP
 * and for checking that a request came from the stdout extension.
 *
 * @param {{ store: import("./store.js").LogStore, commands: import("./commands.js").CommandQueue, commandPollTime?: number }} options
 * @returns {(route: string, body: any, onClose: (listener: () => void) => void) => Promise<object>}
 * Answers one request.  `onClose` registers a listener for the request going
 * away, so a command poll doesn't take a command that nobody will receive.
 */
export function createExtensionRoutes(
	{ store, commands, commandPollTime = DefaultCommandPollTime })
{
	return async function handleExtensionRequest(
		route,
		body,
		onClose)
	{
		if (route === LinkRoutes.Ingest) {
			return store.ingest(body);
		}

		if (route === LinkRoutes.Commands) {
			const { promise, cancel } = commands.poll(commandPollTime);

			onClose(cancel);

			return { commands: await promise };
		}

		const { id, result, error } = body;

		commands.complete(id, { result, error });

		return { ok: true };
	};
}
