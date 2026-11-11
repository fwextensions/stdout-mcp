// @ts-check

/** @typedef {import("../extension/daemon-link.js").Command} Command */

/**
 * @typedef {{ command: Command, browserId?: string, cursor?: string, onPickup: () => void }} PendingCommand
 * A command without a `browserId` goes to whichever browser asks first.
 */

	// the browser ID of a poll from an extension that predates the buffer ID
	// header.  it can't say which browser it is, so it gets any command.
export const UnknownBrowser = "unknown";

/**
 * @typedef {import("../extension/daemon-link.js").CommandResult & { cursor?: string, timedOut?: "pickup"|"result", cancelled?: boolean }} CommandOutcome
 * `cursor` is for reading what was logged after the extension picked up the
 * command.  It's left out if the command was never picked up.  `timedOut` says
 * whether the extension never picked up the command, or picked it up but never
 * said how it went.
 */

/**
 * @typedef {object} CommandTimeouts
 * @property {number} pickupTimeout  How long the extension has to pick up the
 * command.
 * @property {number} runTimeout  How long it then has to say how it went.  This
 * starts over at pickup, so time spent waiting for the extension to ask for
 * commands doesn't cut into the time it has to run one.
 * @property {string} [browserId]  The browser to run the command in.
 */

/**
 * Holds commands for the stdout extension until it asks for them.  The daemon
 * can't reach the extension's service worker, so the worker long-polls for
 * commands while an agent is active.  Each browser has its own poll, so that
 * two browsers' polls don't end each other.
 */
export class CommandQueue
{
	/**
	 * @param {{ getCursor: () => string }} options
	 */
	constructor(
		{ getCursor })
	{
		this.getCursor = getCursor;
		this.nextId = 1;
			/** @type {PendingCommand[]} */
		this.pending = [];
			/** @type {Map<number, (outcome: CommandOutcome) => void>} */
		this.outcomes = new Map();
			/** @type {Map<string, (commands: Command[]) => void>} */
		this.pollers = new Map();
	}

	/**
	 * Queue a command and wait for the extension to report what happened.
	 *
	 * @param {string} name
	 * @param {object} args
	 * @param {CommandTimeouts} timeouts
	 * @returns {{ promise: Promise<CommandOutcome>, cancel: () => void }}
	 */
	send(
		name,
		args,
		{ pickupTimeout, runTimeout, browserId })
	{
		const command = { id: this.nextId++, name, args };
		/** @type {PendingCommand} */
		const item = { command, browserId, onPickup: () => {} };
		let cancel;
		const promise = new Promise((resolve) => {
				// taking the command out of the queue keeps one that timed out from
				// running later, when the agent no longer expects it
			const finish = (outcome) => {
				clearTimeout(timer);
				this.pending = this.pending.filter((pending) => pending !== item);
				this.outcomes.delete(command.id);
				resolve(outcome);
			};
			let timer = setTimeout(() => finish({ timedOut: "pickup" }), pickupTimeout);

			item.onPickup = () => {
				clearTimeout(timer);
				timer = setTimeout(() => finish({ timedOut: "result", cursor: item.cursor }), runTimeout);
			};
			cancel = () => finish({ cancelled: true });
			this.outcomes.set(command.id, (outcome) => finish({ ...outcome, cursor: item.cursor }));
		});

		this.pending.push(item);
		this.deliver();

		return { promise, cancel };
	}

	/**
	 * Wait for commands to send to a browser's stdout extension.  A new poll
	 * from a browser replaces its existing one, which is left over from a service
	 * worker that was shut down.
	 *
	 * @param {string} browserId
	 * @param {number} timeoutMs
	 * @returns {{ promise: Promise<Command[]>, cancel: () => void }}
	 */
	poll(
		browserId,
		timeoutMs)
	{
		this.pollers.get(browserId)?.([]);

		let cancel;
		const promise = new Promise((resolve) => {
			const finish = (commands) => {
				clearTimeout(timer);

				if (this.pollers.get(browserId) === finish) {
					this.pollers.delete(browserId);
				}

				resolve(commands);
			};
			const timer = setTimeout(() => finish([]), timeoutMs);

			cancel = () => finish([]);
			this.pollers.set(browserId, finish);
		});

		this.deliver();

		return { promise, cancel };
	}

	/**
	 * @param {number} id
	 * @param {CommandOutcome} outcome
	 */
	complete(
		id,
		outcome)
	{
		this.outcomes.get(id)?.(outcome);
	}

	/**
	 * Whether any browser is waiting for commands.
	 *
	 * @returns {boolean}
	 */
	hasPoll()
	{
		return this.pollers.size > 0;
	}

	/**
	 * End every poll, such as when the daemon is shutting down.
	 */
	endPolls()
	{
		for (const finish of [...this.pollers.values()]) {
			finish([]);
		}
	}

	deliver()
	{
		for (const [browserId, poller] of [...this.pollers]) {
			const isFor = (item) => !item.browserId || item.browserId === browserId
				|| browserId === UnknownBrowser;
			const pending = this.pending.filter(isFor);

			if (pending.length) {
					// the extension sends its backlog before it picks up a command, which
					// matters when the daemon has just started and has no logs yet
				const cursor = this.getCursor();

				this.pending = this.pending.filter((item) => !isFor(item));
				pending.forEach((item) => {
					item.cursor = cursor;
					item.onPickup();
				});
				poller(pending.map(({ command }) => command));
			}
		}
	}
}
