// @ts-check

// Value tags: labeled objects that stand in for console values JSON can't carry.
// The tap writes them with toJSONSafe().  Logged data can look like a tag, so
// every reader goes through getValueTag() to find out whether an object really
// is one.  This lives in the extension because an unpacked extension can't
// import anything outside its own folder, and it can't use Chrome or Node APIs
// because the tap and the daemon import it too.

export const ValueTag = {
	Undefined: "undefined",
	BigInt: "bigint",
	Number: "number",
	Symbol: "symbol",
	Function: "function",
	RegExp: "RegExp",
	Date: "Date",
	Error: "Error",
	Map: "Map",
	Set: "Set",
	Circular: "Circular",
	Truncated: "Truncated",
	More: "More",
		// ArrayBuffers and typed arrays, which are labeled with their class's name
	Binary: "Binary",
};

const MaxDepth = 8;
const MaxStringLength = 10000;
const MaxItems = 500;

const NonFiniteNumbers = new Set(["NaN", "Infinity", "-Infinity"]);
const BigIntPattern = /^-?\d+$/;

const hasValue = ({ value }) => typeof value === "string";
const isPair = (item) => Array.isArray(item) && item.length === 2;
const hasNoFields = () => true;

	// a Map keeps the rules away from names like "constructor"
const TagRules = new Map(Object.entries({
	[ValueTag.Undefined]: hasNoFields,
	[ValueTag.BigInt]: ({ value }) => typeof value === "string" && BigIntPattern.test(value),
	[ValueTag.Number]: ({ value }) => NonFiniteNumbers.has(value),
	[ValueTag.Symbol]: hasValue,
	[ValueTag.Function]: hasValue,
	[ValueTag.RegExp]: hasValue,
	[ValueTag.Date]: hasValue,
	[ValueTag.Error]: ({ name, message }) => typeof name === "string" && typeof message === "string",
	[ValueTag.Map]: ({ size, entries }) => Number.isInteger(size) && Array.isArray(entries) && entries.every(isPair),
	[ValueTag.Set]: ({ size, values }) => Number.isInteger(size) && Array.isArray(values),
	[ValueTag.Circular]: hasNoFields,
	[ValueTag.Truncated]: hasNoFields,
	[ValueTag.More]: ({ count }) => Number.isInteger(count),
}));

/**
 * Find out which value tag an object is.  It's safe to use the fields of a tag
 * that's returned.
 *
 * @param {any} value  A non-array object.
 * @returns {string|null} One of `ValueTag`, or null if it's an ordinary object,
 * even one with a `__type` field.
 */
export function getValueTag(
	value)
{
	const name = value.__type;

	if (typeof name !== "string") {
		return null;
	}

	const rule = TagRules.get(name);

	if (rule) {
		return rule(value) ? name : null;
	}

	return Number.isInteger(value.byteLength) ? ValueTag.Binary : null;
}

function truncateString(
	value)
{
	if (value.length <= MaxStringLength) {
		return value;
	}

	return `${value.slice(0, MaxStringLength)}… [${value.length - MaxStringLength} more chars]`;
}

/**
 * Convert a value into one that survives being sent to the stdout extension.
 * Extension messages are serialized as JSON, so values JSON can't represent
 * (undefined, bigints, Maps, Errors, cycles, etc.) become value tags, which the
 * stdout extension and MCP server know how to display.  Very long strings, big
 * collections and deep nesting are truncated.
 *
 * @param {any} value
 * @param {number} [depth]
 * @param {WeakSet<object>} [ancestors]
 * @returns {any}
 */
export function toJSONSafe(
	value,
	depth = 0,
	ancestors = new WeakSet())
{
	switch (typeof value) {
		case "string":
			return truncateString(value);

		case "boolean":
			return value;

		case "number":
			return Number.isFinite(value)
				? value
				: { __type: ValueTag.Number, value: String(value) };

		case "undefined":
			return { __type: ValueTag.Undefined };

		case "bigint":
			return { __type: ValueTag.BigInt, value: String(value) };

		case "symbol":
			return { __type: ValueTag.Symbol, value: String(value) };

		case "function":
			return { __type: ValueTag.Function, value: String(value) };
	}

	if (value === null) {
		return null;
	}

	if (ancestors.has(value)) {
		return { __type: ValueTag.Circular };
	}

	if (depth >= MaxDepth) {
		return { __type: ValueTag.Truncated };
	}

	const convert = (child) => toJSONSafe(child, depth + 1, ancestors);

		// only track the current path through the object graph, so that an object
		// referenced twice from different branches isn't reported as circular
	ancestors.add(value);

	try {
		if (value instanceof Error) {
			const { name, message, stack, ...rest } = value;

			return {
				...Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, convert(child)])),
				__type: ValueTag.Error,
				name: name ?? value.constructor?.name ?? "Error",
				message: truncateString(String(message ?? "")),
				stack: typeof stack === "string" ? truncateString(stack) : undefined,
			};
		}

		if (value instanceof Date) {
			return {
				__type: ValueTag.Date,
				value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString(),
			};
		}

		if (value instanceof RegExp) {
			return { __type: ValueTag.RegExp, value: String(value) };
		}

		if (value instanceof Map) {
			return {
				__type: ValueTag.Map,
				size: value.size,
				entries: [...value].slice(0, MaxItems).map(([key, child]) => [convert(key), convert(child)]),
			};
		}

		if (value instanceof Set) {
			return {
				__type: ValueTag.Set,
				size: value.size,
				values: [...value].slice(0, MaxItems).map(convert),
			};
		}

		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
				// binary data is labeled with its class's name, like "Uint8Array"
			return { __type: value.constructor.name, byteLength: value.byteLength };
		}

		if (Array.isArray(value)) {
			const result = value.slice(0, MaxItems).map(convert);

			if (value.length > MaxItems) {
				result.push({ __type: ValueTag.More, count: value.length - MaxItems });
			}

			return result;
		}

		const entries = Object.entries(value);
		const result = Object.fromEntries(entries.slice(0, MaxItems).map(([key, child]) => [key, convert(child)]));

		if (entries.length > MaxItems) {
			result["…"] = { __type: ValueTag.More, count: entries.length - MaxItems };
		}

		return result;
	} finally {
		ancestors.delete(value);
	}
}
