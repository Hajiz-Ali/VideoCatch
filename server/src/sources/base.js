/* The extraction layer is pluggable: each source handler decides which
 * hostnames it can extract, and produces the exact argv for yt-dlp (or
 * another tool) to analyze and to download a format.
 *
 * A new source can be added by implementing the same interface and
 * registering it — no other code needs to change:

 *   class MySource extends BaseSource {
 *     static id = "mysite";
 *     isSupported(hostname) { return hostname === "mysite.com"; }
 *   }
 */

export class BaseSource {
  static id = "generic";

  isSupported(_hostname) {
    return false;
  }

  /** Extra argv to prepend to every yt-dlp invocation (e.g. cookies). */
  commonArgs() {
    return [];
  }

  /** argv for analyzing (dump JSON) — appended after -o NA. */
  analyzeArgs() {
    return [];
  }

  /** argv appended at the end of a download invocation (after URL). */
  downloadArgs() {
    return [];
  }

  /** Merge into args: template for per-source pre/post handling if needed. */
  postProcessArgs() {
    return [];
  }
}

/** Default source: a broad yt-dlp-backed handler for any allowlisted host. */
export class GenericYtDlpSource extends BaseSource {
  static id = "generic";

  isSupported(_hostname) {
    return true; // allowlisting is enforced by the URL guard, not here.
  }
}