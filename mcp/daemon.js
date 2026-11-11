// @ts-check
import { createDaemonServer } from "./daemon-server.js";
import { ExtensionOrigin, IdleTimeout, Port } from "./constants.js";

// The daemon process, which MCP servers start when it isn't running.

const { server } = createDaemonServer({
	port: Port,
	extensionOrigin: ExtensionOrigin,
	idleTimeout: IdleTimeout,
		// exit when the agent sessions using us are done
	onIdle: () => process.exit(0),
});

server.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
		// another copy of the daemon is already running, so let it handle things
	process.exit(error.code === "EADDRINUSE" ? 0 : 1);
});

server.listen(Port, "127.0.0.1");
