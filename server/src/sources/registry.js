import { GenericYtDlpSource } from "./base.js";

export class SourceRegistry {
  constructor(handlers = []) {
    this.handlers = handlers;
  }

  /** Register more handlers (e.g. from future source modules). */
  register(handler) {
    this.handlers.push(handler);
    return this;
  }

  /** First handler that claims the hostname, else null. */
  findForHost(hostname) {
    return this.handlers.find((h) => h.isSupported(hostname)) || null;
  }
}

/** Application-wide registry. New source modules import/register here. */
export const registry = new SourceRegistry([new GenericYtDlpSource()]);