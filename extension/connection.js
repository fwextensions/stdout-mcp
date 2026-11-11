// @ts-check

// The daemon connection: the stdout extension's ongoing effort, during agent
// mode, to keep the daemon caught up and answer its commands.  It can't use
// Chrome APIs, so that it can be tested against a real daemon.

export const ConnectionStatus = {
	Off: "off",
	Looking: "looking",
	Connected: "connected",
};

const DefaultDelays = {
		// batches up bursts of log calls
	flush: 250,
		// after a failed request, leave retries to check-ins instead of trying again
		// on every new log message
	retryAfterFailure: 30 * 1000,
		// right after agent mode is turned on or Chrome starts, an agent session is
		// likely to start soon, so check for the daemon more often than check-ins do
	fastRetry: 5 * 1000,
	fastRetryDuration: 3 * 60 * 1000,
};

/**
 * @typedef {object} DaemonConnectionOptions
 * @property {ReturnType<typeof import("./daemon-link.js").createDaemonLink>} link
 * @property {() => Promise<string>} getBufferId
 * @property {() => Promise<string>} [getBrowserName]  What agents should call
 * this browser.
 * @property {(position: number, limit: number) => Promise<object[]>} getEntriesAfter
 * @property {() => Promise<boolean>} isAgentMode  The source of truth for whether
 * agent mode is on.  This must make a real call into Chrome, because calling it
 * between requests is what keeps the service worker awake.
 * @property {(command: import("./daemon-link.js").Command) => Promise<import("./daemon-link.js").CommandResult>} runCommand
 * @property {(status: string) => void|Promise<void>} onStatus  Called with a
 * ConnectionStatus after every attempt to reach the daemon, even if it's the same
 * as last time, since a restarted service worker doesn't know what was shown.
 * @property {Partial<typeof DefaultDelays>} [delays]
 */

/**
 * A new connection is looking for the daemon, not off, since a service worker
 * can be woken at any time without start() being called.
 *
 * The backlog always goes out before the first command poll, so entries logged
 * before a command was sent come before the cursor that an agent gets for it.
 * Later polls can overlap with sending entries.
 *
 * @param {DaemonConnectionOptions} options
 */
export function createDaemonConnection(
	{ link, getBufferId, getBrowserName = async () => "", getEntriesAfter, isAgentMode, runCommand, onStatus, delays })
{
	const { flush: flushDelay, retryAfterFailure, fastRetry, fastRetryDuration } = { ...DefaultDelays, ...delays };
	let status = ConnectionStatus.Looking;
		// null when we'd have to ask the daemon where it is
		/** @type {number|null} */
	let syncPosition = null;
		/** @type {ReturnType<typeof setTimeout>|null} */
	let flushTimer = null;
		/** @type {Promise<void>|null} */
	let flushing = null;
	let flushAgain = false;
	let lastFailure = 0;
	let polling = false;
	let retrying = false;

	function flush()
	{
		if (flushing) {
			flushAgain = true;
		} else {
			flushing = sendEntries()
				.finally(() => {
					flushing = null;

					if (flushAgain) {
						flushAgain = false;
						flush();
					}
				});
		}

		return flushing;
	}

	/**
	 * Whether a sync that just finished should still count.  Agent mode may have
	 * been turned off while it was in flight.
	 */
	async function isStillOn()
	{
		return await isAgentMode() && status !== ConnectionStatus.Off;
	}

	async function sendEntries()
	{
		if (!await isAgentMode()) {
			return;
		}

		try {
			const bufferId = await getBufferId();
			const browserName = await getBrowserName();
			const position = await link.catchUp({ bufferId, browserName, syncPosition, getEntriesAfter });

			if (await isStillOn()) {
				syncPosition = position;
				status = ConnectionStatus.Connected;
				await onStatus(status);
				pollCommands();
			}
		} catch {
				// the daemon isn't running, which is the normal state when no agent is
				// using it.  if it's running and rejected the batch, it tells agents.
			if (await isStillOn()) {
				syncPosition = null;
				lastFailure = Date.now();
				status = ConnectionStatus.Looking;
				await onStatus(status);
			}
		}
	}

	/**
	 * @param {import("./daemon-link.js").Command} command
	 */
	async function answerCommand(
		bufferId,
		command)
	{
		const outcome = await isAgentMode()
			? await runCommand(command)
			: { error: "Agent mode was turned off in the stdout extension." };

		await link.sendCommandResult(bufferId, command.id, outcome);
	}

	/**
	 * Ask the daemon for commands for as long as it's running.  If it goes away, the
	 * next successful sync starts this again.
	 */
	async function pollCommands()
	{
		if (polling) {
			return;
		}

		polling = true;

		try {
			const bufferId = await getBufferId();

			while (await isAgentMode()) {
				const commands = await link.pollCommands(bufferId);

				await Promise.all(commands.map((command) => answerCommand(bufferId, command)));
			}
		} catch {
				// a check-in will start polling again once the daemon is back
		} finally {
			polling = false;
		}
	}

	/**
	 * Check for the daemon every few seconds for a little while, until it's found.
	 */
	async function retryUntilConnected()
	{
		if (retrying) {
			return;
		}

		retrying = true;

		const deadline = Date.now() + fastRetryDuration;

		try {
			while (Date.now() < deadline && await isAgentMode()) {
				await flush();

				if (status === ConnectionStatus.Connected) {
					break;
				}

				await new Promise((resolve) => setTimeout(resolve, fastRetry));
			}
		} finally {
			retrying = false;
		}
	}

	return {
		/**
		 * Agent mode was turned on, or Chrome started with it on.
		 */
		async start()
		{
			status = ConnectionStatus.Looking;
			lastFailure = 0;
			await onStatus(status);
			retryUntilConnected();
		},

		/**
		 * Agent mode was turned off.  A command poll that's in flight is left to
		 * finish, and answers any command it gets with an error.
		 */
		async stop()
		{
			status = ConnectionStatus.Off;
			syncPosition = null;
			await onStatus(status);
		},

		/**
		 * Offer the daemon anything it's missing, even after a recent failure.
		 */
		checkIn()
		{
			lastFailure = 0;

			return flush();
		},

		/**
		 * A log entry was stored, so send it shortly.
		 */
		entryAdded()
		{
			if (!flushTimer && Date.now() - lastFailure > retryAfterFailure) {
				flushTimer = setTimeout(() => {
					flushTimer = null;
					flush();
				}, flushDelay);
			}
		},
	};
}
