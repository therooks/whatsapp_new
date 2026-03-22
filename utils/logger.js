const stamp = () => new Date().toISOString();

export const log = (...args) => console.log(`[${stamp()}]`, ...args);
export const warn = (...args) => console.warn(`[${stamp()}][WARN]`, ...args);
export const err = (...args) => console.error(`[${stamp()}][ERR]`, ...args);

export const dumpError = (title, e) => {
  err(title);
  try {
    if (e?.stack) console.error(e.stack);
    else if (typeof e === "object") console.error(JSON.stringify(e, null, 2));
    else console.error(String(e));
  } catch (_) {
    console.error(e);
  }
};
