/** Tiny structured-ish logger. Keeps logs greppable without a heavy dep. */
type Level = "info" | "warn" | "error" | "debug";

function log(level: Level, scope: string, msg: string, extra?: unknown) {
  const line = `[${level.toUpperCase()}] (${scope}) ${msg}`;
  const payload = extra !== undefined ? [line, extra] : [line];
  if (level === "error") console.error(...payload);
  else if (level === "warn") console.warn(...payload);
  else console.log(...payload);
}

export const logger = {
  info: (scope: string, msg: string, extra?: unknown) => log("info", scope, msg, extra),
  warn: (scope: string, msg: string, extra?: unknown) => log("warn", scope, msg, extra),
  error: (scope: string, msg: string, extra?: unknown) => log("error", scope, msg, extra),
  debug: (scope: string, msg: string, extra?: unknown) => {
    if (process.env.DEBUG) log("debug", scope, msg, extra);
  },
};
