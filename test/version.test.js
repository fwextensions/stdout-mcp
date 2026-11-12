import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, getPackageVersion, shouldReplaceDaemon } from "../mcp/version.js";

test("orders package versions", () => {
	assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
	assert.equal(compareVersions("0.10.0", "0.9.3"), 1);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("0.2.0-beta.1", "0.2.0"), -1);
	assert.equal(compareVersions("0.2.0-beta.10", "0.2.0-beta.9"), 1);
	assert.ok(compareVersions(undefined, "0.1.0") < 0);
	assert.ok(compareVersions("0.1.0", "nonsense") > 0);
});

test("replaces a daemon from an older package, but not a newer one", () => {
	const starting = { packageVersion: "0.2.0", codeVersion: "abc" };

	assert.equal(shouldReplaceDaemon({ packageVersion: "0.1.0", codeVersion: "old" }, starting), true);
	assert.equal(shouldReplaceDaemon({ packageVersion: "0.3.0", codeVersion: "new" }, starting), false);
		// daemons that predate package versions in their health check
	assert.equal(shouldReplaceDaemon({ codeVersion: "old" }, starting), true);
});

test("with the same package, replaces a daemon only if its code differs", () => {
	const starting = { packageVersion: "0.2.0", codeVersion: "abc" };

	assert.equal(shouldReplaceDaemon({ packageVersion: "0.2.0", codeVersion: "abc" }, starting), false);
	assert.equal(shouldReplaceDaemon({ packageVersion: "0.2.0", codeVersion: "edited" }, starting), true);
});

test("reads this package's version", () => {
	assert.match(getPackageVersion(), /^\d+\.\d+\.\d+/);
});
