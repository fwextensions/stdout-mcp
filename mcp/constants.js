// @ts-check
import { DefaultPort } from "../extension/daemon-link.js";
import { StdoutId } from "../extension/tap-link.js";

export const Port = Number(process.env.STDOUT_MCP_PORT) || DefaultPort;

export const BaseURL = `http://127.0.0.1:${Port}`;

	// only the stdout extension may send log entries
export const ExtensionOrigin = `chrome-extension://${StdoutId}`;

	// the daemon exits after this long without a request from an MCP server, so
	// it doesn't linger after the agent sessions using it are done
export const IdleTimeout = (Number(process.env.STDOUT_MCP_IDLE_MINUTES) || 120) * 60 * 1000;
