import packageInfo from "../package.json";
/** Production values are injected by Vite; Node-only tools can still read the declared version. */
export const buildInfo = Object.freeze(typeof __BAND_BUILD__ !== "undefined"
  ? __BAND_BUILD__
  : { version: packageInfo.version, commit: "development", fullCommit: "" });
