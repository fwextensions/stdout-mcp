// @ts-check
import { LinkRoutes } from "../extension/daemon-link.js";
import { getBrowserId } from "./store.js";

	// Chrome shuts down a service worker whose fetch takes more than 30 seconds
const DefaultCommandPollTime = 25 * 1000;

export const ExtensionRoutes = new Set(Object.values(LinkRoutes));

/**
 * The daemon's half of the Daemon Link.  The caller is responsible for HTTP
 * and for checking that a request came from the stdout extension.
 *
 * @param {{ store: import("./store.js").LogStore, commands: import("./commands.js").CommandQueue, commandPollTime?: number }} options
 * @returns {(route: string, readBody: () => Promise<any>, onClose: (listener: () => void) => void, bufferId?: string) => Promise<object>}
 * Answers one request.  `readBody` throws if the request can't be read, such as
 * when it's too large.  `onClose` registers a listener for the request going
 * away, so a command poll doesn't take a command that nobody will receive.
 * `bufferId` comes from the request's header, and is missing from extensions
 * that predate it.
 */
export function createExtensionRoutes(
	{ store, commands, commandPollTime = DefaultCommandPollTime })
{
	return async function handleExtensionRequest(
		route,
		readBody,
		onClose,
		bufferId)
	{
		if (route === LinkRoutes.Ingest) {
			try {
				return store.ingest(await readBody());
			} catch (error) {
				store.recordRejectedBatch(error.message, bufferId);
				throw error;
			}
		}

		if (route === LinkRoutes.Commands) {
			const { promise, cancel } = commands.poll(getBrowserId(bufferId), commandPollTime);

			onClose(cancel);

			return { commands: await promise };
		}

		const { id, result, error } = await readBody();

		commands.complete(id, { result, error });

		return { ok: true };
	};
}
