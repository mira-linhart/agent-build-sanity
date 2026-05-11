// Version helpers: prerelease detection, version comparison.
//
// The PyPI ecosystem in particular publishes dev / alpha / beta / rc versions
// to the same registry as stable releases. deps.dev's `isDefault` flag can
// land on a prerelease if the maintainer didn't tag a stable yet, or if the
// most-recent publish was a dev-channel push. We treat prereleases as the
// fallback, not the default, for "latest" semantics.

const PRERELEASE_PATTERN = /(?:^|[-.\d])(?:a|alpha|b|beta|rc|dev|pre|preview)\d*/i;

export function isPrerelease(version: string): boolean {
  // Strip the leading numeric core (e.g. "2.34.0") so a leading number with
  // no prerelease marker doesn't accidentally match.
  const without_core = version.replace(/^v?\d+(?:\.\d+)*/, "");
  return PRERELEASE_PATTERN.test(without_core);
}
