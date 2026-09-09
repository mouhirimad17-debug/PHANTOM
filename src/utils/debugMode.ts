const DEBUG_STORAGE_KEY = 'phantom:debug';

/**
 * Developer/debug mode gate — see README's "Developer / debug mode" section
 * for the user-facing documentation of this flag.
 *
 * Enabled by loading the app with `?debug=1` in the URL (or disabled again
 * with `?debug=0`), which also persists the choice to `localStorage` so it
 * survives reloads without needing to keep the query param around. Reading
 * `localStorage` directly (e.g. from the browser console) works too, for a
 * developer who doesn't want to touch the URL at all.
 *
 * Storage access is wrapped in try/catch: private browsing modes and some
 * locked-down embedded contexts throw on any `localStorage` access rather
 * than just returning null, and debug mode is diagnostic-only — it must
 * never be the thing that breaks the app for a normal user.
 */
export function isDebugModeEnabled(): boolean {
  const queryFlag = new URLSearchParams(window.location.search).get('debug');

  if (queryFlag === '1' || queryFlag === 'true') {
    try {
      window.localStorage.setItem(DEBUG_STORAGE_KEY, '1');
    } catch {
      // Ignore storage failures — the flag still applies for this page load.
    }
    return true;
  }

  if (queryFlag === '0' || queryFlag === 'false') {
    try {
      window.localStorage.removeItem(DEBUG_STORAGE_KEY);
    } catch {
      // Ignore storage failures — the flag still applies for this page load.
    }
    return false;
  }

  try {
    return window.localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
