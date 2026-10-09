module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        "babel-preset-expo",
        // pdf.js (file preview) references import.meta.url in Node-only
        // branches; Metro emits classic scripts, so polyfill it.
        { jsxImportSource: "nativewind", unstable_transformImportMeta: true },
      ],
      "nativewind/babel",
    ],
  };
};
