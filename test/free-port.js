import { createServer } from "node:net";
import { once } from "node:events";

/**
 * Find a port that a daemon started by a test can listen on.  Picking one at
 * random can land on a port that Windows reserves, which a daemon can't listen
 * on, so let the OS choose one, then free it.
 *
 * @returns {Promise<number>}
 */
export async function getFreePort()
{
	const server = createServer().listen(0, "127.0.0.1");

	await once(server, "listening");

	const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

	server.close();
	await once(server, "close");

	return port;
}
