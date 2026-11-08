// @ts-check

/**
 * @typedef {object} Command
 * @property {number} id
 * @property {string} name
 * @property {object} args
 */

/**
 * @typedef {object} CommandOutcome
 * @property {any} [result]  What the stdout extension returned.
 * @property {string} [error]  Why the stdout extension couldn't run the command.
 * @property {boolean} [timedOut]
 * @property {boolean} [cancelled]
 */

/**
 * Holds commands for the stdout extension until it asks for them.  The daemon
 * can't reach the extension's service worker, so the worker long-polls for
 * commands while an agent is active.
 */
export class CommandQueue
{
	constructor()
	{
		this.nextId = 1;
			/** @type {Command[]} */
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
		let cancel;
		const promise = new Promise((resolve) => {
				// taking the command out of the queue keeps one that timed out from
				// running later, when the agent no longer expects it
			const finish = (outcome) => {
				clearTimeout(timer);
				this.pending = this.pending.filter((pending) => pending !== command);
				this.outcomes.delete(command.id);
				resolve(outcome);
			};
			const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

			cancel = () => finish({ cancelled: true });
			this.outcomes.set(command.id, finish);
		});

		this.pending.push(command);
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
			const commands = this.pending;

			this.pending = [];
			this.poller(commands);
		}
	}
}
