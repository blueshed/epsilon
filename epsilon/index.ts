/**
 * @blueshed/epsilon — one op stream, Postgres to pixel.
 *
 * The CLIENT surface. Server-side pieces are imported from their own files
 * (`epsilon/pg`, `epsilon/migrate`, `epsilon/law`) so a browser bundle never
 * pulls Postgres in behind them.
 */
export type { Op } from "./op";
// escapeToken belongs beside splitPath: any id that can contain "/" or "~"
// — an email used as a record key, most obviously — has to be escaped before
// it goes into a JSON Pointer, and string concatenation quietly builds the
// wrong path. ui.ts uses it for exactly this.
export { splitPath, valueAt, escapeToken } from "./op";
export {
  Signal, signal, computed, effect, batch, untrack,
  pushDisposeScope, popDisposeScope, trackDispose, hasActiveDisposeScope,
} from "./signal";
export type { OpSignal, ReadonlySignal, SignalOptions, Dispose } from "./signal";
export { createHost, connect } from "./doc";
export type { Host, Remote, DocHandle } from "./doc";
export { list, text, mount } from "./ui";
export { routes, route, navigate, matchRoute } from "./route";
export type { RouterOptions } from "./route";
