// @ts-check

// What agents call the browser this copy of the stdout extension runs in.  The
// user can give it a name, such as "Canary" or "Chrome: work", since nothing
// an extension can read tells Chrome's channels or profiles apart.  Otherwise,
// it's the browser's brand and major version, like "Edge 146".  This can't use
// Chrome APIs, so that it can be tested.

export const BrowserNameKey = "browserName";

	// the longest name the daemon is sent
export const MaxBrowserNameLength = 40;

const ShortBrands = {
	"Google Chrome": "Chrome",
	"Microsoft Edge": "Edge",
};

/**
 * @typedef {{ brand: string, version: string }} Brand
 */

/**
 * @param {{ userAgentData?: { brands?: Brand[] } }} [nav]  The navigator, or
 * something shaped like it.
 * @returns {string}
 */
export function getDefaultBrowserName(
	nav = /** @type {any} */ (globalThis.navigator))
{
	const brands = nav?.userAgentData?.brands ?? [];
		// browsers add a made-up brand, like "Not.A/Brand", so sites can't count on
		// the list, and every Chromium browser lists Chromium too
	const real = brands.filter(({ brand }) => !/not.a.brand/i.test(brand));
	const { brand, version } = real.find(({ brand }) => brand !== "Chromium")
		?? real[0]
		?? { brand: "", version: "" };

	if (!brand) {
		return "browser";
	}

	return `${ShortBrands[brand] ?? brand}${version ? ` ${version}` : ""}`;
}

/**
 * @param {unknown} name  The name the user gave the browser, if any.
 * @param {Parameters<typeof getDefaultBrowserName>[0]} [nav]
 * @returns {string}
 */
export function getBrowserName(
	name,
	nav)
{
	const custom = typeof name === "string" ? name.trim().slice(0, MaxBrowserNameLength) : "";

	return custom || getDefaultBrowserName(nav);
}
