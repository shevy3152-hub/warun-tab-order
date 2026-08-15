export function rewriteInlineModuleSpecifiers(javascript, scriptUrl) {
  if (typeof javascript !== "string" || typeof scriptUrl !== "string") {
    throw new TypeError("JavaScript and its original script URL are required.");
  }
  const scriptBase = new URL(scriptUrl, "https://warun.invalid/");
  return javascript.replace(
    /(\b(?:from|import)\s*(?:\(\s*)?)(["'])(\.\.?\/[^"']+)\2/g,
    (match, prefix, quote, specifier) => {
      const resolved = new URL(specifier, scriptBase);
      return `${prefix}${quote}${resolved.pathname}${resolved.search}${resolved.hash}${quote}`;
    },
  );
}
