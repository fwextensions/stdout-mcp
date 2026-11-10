import { test } from "node:test";
import assert from "node:assert/strict";
import { toJSONSafe } from "../lib/stdout.js";
import { fromJSONSafe } from "../extension/deserialize.js";
import { getValueTag, ValueTag } from "../extension/value-tags.js";
import { formatArgs } from "../mcp/format.js";

const format = (...args) => formatArgs(JSON.parse(JSON.stringify(args.map((arg) => toJSONSafe(arg)))));

test("formats primitives and plain values like the console", () => {
	assert.equal(format("hello", 42, true, null, undefined), "hello 42 true null undefined");
	assert.equal(format({ a: 1, "b-c": "x" }, [1, "two"]), '{a: 1, "b-c": "x"} [1, "two"]');
	assert.equal(format(10n, NaN, -Infinity), "10n NaN -Infinity");
});

test("applies printf-style substitutions", () => {
	assert.equal(format("%s has %d items (%c50%%)", "cart", 3.7, "color: red"), "cart has 3 items (50%)");
	assert.equal(format("%o", { a: [1] }), "{a: [1]}");
	assert.equal(format("100%", "extra"), "100% extra");
	assert.equal(format("%s %s", "only one"), "only one %s");
});

test("formats special objects", () => {
	const map = new Map([["k", new Set([1])]]);

	assert.equal(format(map), 'Map(1) {"k" => Set(1) {1}}');
	assert.equal(format(new Date(0)), "1970-01-01T00:00:00.000Z");
	assert.equal(format(/a+/g), "/a+/g");
	assert.equal(format(new Uint8Array(4)), "Uint8Array(4)");
});

test("handles cycles without marking shared references as circular", () => {
	const shared = { x: 1 };
	const value = { a: shared, b: shared };

	value.self = value;
	assert.equal(format(value), "{a: {x: 1}, b: {x: 1}, self: [Circular]}");
});

test("formats errors with their stack and extra fields", () => {
	const error = new TypeError("bad thing");

	error.code = 42;

	const text = format("failed:", { cause: error });

	assert.match(text, /^failed: \{cause: TypeError: bad thing\n {4}at /);
	assert.match(text, / \{code: 42\}\}$/);
		// older versions of the library send errors without a stack
	assert.equal(formatArgs([{ __type: "Error", name: "Error", message: "boom" }]), "Error: boom");
});

test("truncates long strings, big arrays and deep nesting", () => {
	assert.match(format("x".repeat(10010)), /… \[10 more chars\]$/);
	assert.match(format(Array.from({ length: 502 }, () => 0)), /, …2 more\]$/);

	let deep = {};

	for (let i = 0; i < 10; i++) {
		deep = { deep };
	}

	assert.match(format(deep), /\[…\]/);
});

for (const tagged of [
	{ __type: "Map" },
	{ __type: "Map", size: 1, entries: "nope" },
	{ __type: "Map", size: 1, entries: [1] },
	{ __type: "Set" },
	{ __type: "Set", size: 1, values: {} },
	{ __type: "bigint" },
	{ __type: "bigint", value: "abc" },
	{ __type: "number", value: "12" },
	{ __type: "Date" },
	{ __type: "Error" },
	{ __type: "More" },
	{ __type: "constructor" },
	{ __type: "ResourceNotFoundException", message: "from an AWS response" },
	{ __type: 5, byteLength: 1 },
]) {
	test(`treats ${JSON.stringify(tagged)} as an ordinary object`, () => {
		const copy = JSON.parse(JSON.stringify(tagged));
		const entries = Object.entries(copy).map(([key, item]) => `${key}: ${JSON.stringify(item).replaceAll(",", ", ")}`);

		assert.equal(getValueTag(copy), null);
		assert.deepEqual(fromJSONSafe(copy), tagged);
		assert.equal(formatArgs([copy]), `{${entries.join(", ")}}`);
	});
}

test("every value tag the library writes is one the readers accept", () => {
	const self = {};

	self.self = self;

	let deep = {};

	for (let i = 0; i < 10; i++) {
		deep = { deep };
	}

	const encoded = toJSONSafe([
		undefined, 1n, -1n, NaN, Infinity, -Infinity, Symbol("a"), () => {}, /a/, new Date(0), new Date(NaN),
		new TypeError("x"), new Map([[1, 2]]), new Set([1]), new ArrayBuffer(1), new Uint8Array(1), self, deep,
		Array.from({ length: 501 }, () => 0),
	]);
	const seen = new Set();

	(function visit(value) {
		if (value && typeof value === "object") {
			if (!Array.isArray(value) && "__type" in value) {
				const tag = getValueTag(value);

				assert.ok(tag, `not accepted: ${JSON.stringify(value)}`);
				seen.add(tag);
			}

			Object.values(value).forEach(visit);
		}
	})(JSON.parse(JSON.stringify(encoded)));

	assert.deepEqual([...seen].sort(), Object.values(ValueTag).sort());
});

test("both readers show binary data the same way", () => {
	const encoded = JSON.parse(JSON.stringify(toJSONSafe(new Uint8Array(4))));

	assert.equal(formatArgs([encoded]), "Uint8Array(4)");
	assert.equal(fromJSONSafe(encoded), "Uint8Array(4)");
});

test("rebuilds values for display in the stdout extension's console", () => {
	const error = new RangeError("too far");
	const value = fromJSONSafe(JSON.parse(JSON.stringify(toJSONSafe({
		error,
		map: new Map([[1, new Set(["a"])]]),
		date: new Date(0),
		missing: undefined,
		big: 5n,
	}))));

	assert.ok(value.error instanceof Error);
	assert.equal(value.error.name, "RangeError");
	assert.equal(value.error.stack, error.stack);
	assert.deepEqual(value.map, new Map([[1, new Set(["a"])]]));
	assert.deepEqual(value.date, new Date(0));
	assert.ok("missing" in value && value.missing === undefined);
	assert.equal(value.big, 5n);
});
