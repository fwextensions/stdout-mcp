import { getValueTag, ValueTag } from "./value-tags.js";

/**
 * Rebuild the values that the stdout() library converted to send them as JSON,
 * as best we can, so they display naturally in this extension's console.
 *
 * @param {any} value
 * @returns {any}
 */
export function fromJSONSafe(
	value)
{
	if (Array.isArray(value)) {
		return value.map(fromJSONSafe);
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	switch (getValueTag(value)) {
		case ValueTag.Undefined:
			return undefined;

		case ValueTag.BigInt:
			return BigInt(value.value);

		case ValueTag.Number:
			return Number(value.value);

		case ValueTag.Date:
			return new Date(value.value);

		case ValueTag.Map:
			return new Map(value.entries.map(([key, item]) => [fromJSONSafe(key), fromJSONSafe(item)]));

		case ValueTag.Set:
			return new Set(value.values.map(fromJSONSafe));

		case ValueTag.Error: {
			const { __type, name, message, stack, ...rest } = value;
			const error = new Error(message);

			Object.assign(error, { name, stack }, fromJSONSafe(rest));

			return error;
		}

		case ValueTag.Symbol:
		case ValueTag.Function:
		case ValueTag.RegExp:
			return value.value;

		case ValueTag.Circular:
			return "[Circular]";

		case ValueTag.Truncated:
			return "[…]";

		case ValueTag.More:
			return `…${value.count} more`;

		case ValueTag.Binary:
			return `${value.__type}(${value.byteLength})`;
	}

	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromJSONSafe(item)]));
}
