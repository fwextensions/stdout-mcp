// @ts-check

// Value tags: labeled objects that stand in for console values JSON can't carry.
// The stdout() library writes them.  Logged data can look like a tag, so every
// reader goes through here to find out whether an object really is one.  This
// lives in the extension because an unpacked extension can't import anything
// outside its own folder, and it can't use Chrome or Node APIs because the
// daemon imports it too.

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
