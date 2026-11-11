import { test } from "node:test";
import assert from "node:assert/strict";
import { getBrowserName, getDefaultBrowserName } from "../extension/browser-name.js";

const navigatorWith = (...brands) => ({
	userAgentData: { brands: brands.map(([brand, version]) => ({ brand, version })) },
});
const Chrome = navigatorWith(["Not)A;Brand", "8"], ["Chromium", "146"], ["Google Chrome", "146"]);
const Edge = navigatorWith(["Microsoft Edge", "146"], ["Not.A/Brand", "99"], ["Chromium", "146"]);

test("names the browser by its brand and major version", () => {
	assert.equal(getDefaultBrowserName(Chrome), "Chrome 146");
	assert.equal(getDefaultBrowserName(Edge), "Edge 146");
	assert.equal(getDefaultBrowserName(navigatorWith(["Brave", "146"], ["Chromium", "146"])), "Brave 146");
	assert.equal(getDefaultBrowserName(navigatorWith(["Chromium", "148"], ["Not=A?Brand", "24"])), "Chromium 148");
	assert.equal(getDefaultBrowserName({}), "browser");
});

test("a name the user gave the browser comes first", () => {
	assert.equal(getBrowserName("  Canary ", Chrome), "Canary");
	assert.equal(getBrowserName("", Chrome), "Chrome 146");
	assert.equal(getBrowserName(undefined, Edge), "Edge 146");
	assert.equal(getBrowserName("x".repeat(100), Chrome).length, 40);
});
