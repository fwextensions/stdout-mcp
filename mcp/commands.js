// @ts-check

/** @typedef {import("../extension/daemon-link.js").Command} Command */

/**
 * @typedef {import("../extension/daemon-link.js").CommandResult & { cursor?: string, timedOut?: boolean, cancelled?: boolean }} CommandOutcome
 * `cursor` is for reading what was logged after the extension picked up the
 * command.  It's left out if the command never got a result.
 */

/**
 * Holds commands for the stdout extension until it asks for them.  The daemon
 * can't reach the extension's service worker, so the worker long-polls for
 * commands while an agent is active.
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
			/** @type {{ command: Command, cursor?: string }[]} */
		this.pending = [];
			/** @type {Map<number, (outcome: CommandOutcome) => void>} */
		this.outcomes = new Map();
			/** @type {((commands: Command[]) => void)|null} */
		this.poller = null;
	}

	/**
	 * Queue a command and wait for the extension to report what happened.
	 *
	 * @param {string} name
	 * @param {object} args
	 * @param {number} timeoutMs
	 * @returns {{ promise: Promise<CommandOutcome>, cancel: () => void }}
	 */
	send(
		name,
		args,
		timeoutMs)
	{
		const command = { id: this.nextId++, name, args };
		/** @type {{ command: Command, cursor?: string }} */
		const item = { command };
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
			const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

			cancel = () => finish({ cancelled: true });
			this.outcomes.set(command.id, (outcome) => finish({ ...outcome, cursor: item.cursor }));
		});

		this.pending.push(item);
		this.deliver();

		return { promise, cancel };
	}

	/**
	 * Wait for commands to send to the extension.  A new poll replaces an existing
	 * one, which is left over from a service worker that was shut down.
	 *
	 * @param {number} timeoutMs
	 * @returns {{ promise: Promise<Command[]>, cancel: () => void }}
	 */
	poll(
		timeoutMs)
	{
		this.poller?.([]);

		let cancel;
		const promise = new Promise((resolve) => {
			const finish = (commands) => {
				clearTimeout(timer);

				if (this.poller === finish) {
					this.poller = null;
				}

				resolve(commands);
			};
			const timer = setTimeout(() => finish([]), timeoutMs);

			cancel = () => finish([]);
			this.poller = finish;
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

	deliver()
	{
		if (this.poller && this.pending.length) {
			const pending = this.pending;
				// the extension sends its backlog before it picks up a command, which
				// matters when the daemon has just started and has no logs yet
			const cursor = this.getCursor();

			this.pending = [];
			pending.forEach((item) => item.cursor = cursor);
			this.poller(pending.map(({ command }) => command));
		}
	}
}
