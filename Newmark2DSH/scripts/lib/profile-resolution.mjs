/**
 * Ask the *shipping* DSH overlay resolver which packages one profile can resolve.
 *
 * Why this exists
 * ---------------
 * `dsh-plugin-desktop` owns module resolution for a profile-launched Harness
 * (`resources/app/lib/module-resolution-*.js`). When the Cordis Loader imports a
 * Loader row module by bare name, the resolver calls
 * `findOverlayPackage(name, { installPackageUrl, profilePackageUrl })` and throws
 * `PackageOverlayNotFoundError` when neither the Desktop installation nor the
 * active Profile provides the package. For a profile-side package the manifest
 * must also live under `<profile>/node_modules` (`package-overlay-*.js`
 * `readCandidate`, the `source === 'profile'` guard).
 *
 * So "can the Loader import this row?" is exactly "does `findOverlayPackage`
 * return a candidate?", and that question is answerable in a plain child process
 * without restarting the running app. This module answers it with the shipped
 * code rather than a reimplementation, so a Desktop update cannot silently
 * invalidate the answer: the module is found by glob and its export is identified
 * by behaviour, not by the mangled name it ships under.
 *
 * Never writes anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default installation root; override with DSH_DESKTOP_APP_DIR. */
export const DEFAULT_DESKTOP_APP_DIR =
  process.env.DSH_DESKTOP_APP_DIR ??
  'C:\\Users\\12252\\AppData\\Local\\Programs\\DSH Desktop\\resources\\app';

/** `<app>/lib`, where the resolver and the overlay selection live. */
export function desktopLibDir(appDir = DEFAULT_DESKTOP_APP_DIR) {
  return path.join(appDir, 'lib');
}

/** The Desktop installation manifest, one of the two overlay anchors. */
export function desktopManifest(appDir = DEFAULT_DESKTOP_APP_DIR) {
  return path.join(appDir, 'package.json');
}

/**
 * Newest `package-overlay-*.js` beside the resolver, so a Desktop rebuild that
 * rehashes the chunk name keeps working.
 * @returns Absolute path, or undefined when the installation does not have one.
 */
export function overlayModulePath(appDir = DEFAULT_DESKTOP_APP_DIR) {
  const dir = desktopLibDir(appDir);
  if (!fs.existsSync(dir)) return undefined;
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => /^package-overlay-.*\.js$/.test(name))
    .map((name) => path.join(dir, name))
    .sort();
  return candidates.at(-1);
}

/**
 * Import `findOverlayPackage` from the Desktop bundle.
 *
 * The chunk is minified, so the export ships under a one-letter alias. Identify
 * it by behaviour: it is the exported function that accepts the two-anchor option
 * object and answers with `{ selected, ... }` or `undefined`.
 */
export async function loadFindOverlayPackage(appDir = DEFAULT_DESKTOP_APP_DIR) {
  const modulePath = overlayModulePath(appDir);
  if (modulePath === undefined) {
    throw new Error(`package-overlay-*.js not found under ${desktopLibDir(appDir)}`);
  }
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.findOverlayPackage === 'function') return module.findOverlayPackage;
  const options = {
    installPackageUrl: pathToFileURL(desktopManifest(appDir)).href,
    profilePackageUrl: pathToFileURL(desktopManifest(appDir)).href,
  };
  for (const value of Object.values(module)) {
    if (typeof value !== 'function') continue;
    try {
      const result = value('dsh-plugin-desktop', options);
      if (result === undefined || (result !== null && typeof result === 'object' && 'selected' in result)) {
        return value;
      }
    } catch {
      /* not the resolver */
    }
  }
  throw new Error(`cannot identify findOverlayPackage among the exports of ${modulePath}`);
}

/**
 * Resolve one package name the way a Loader row import would.
 * @returns `{ resolved: true, source, packageDir }` or `{ resolved: false, error }`.
 */
export function selectOverlayPackage(findOverlayPackage, profileDir, name, appDir = DEFAULT_DESKTOP_APP_DIR) {
  try {
    const overlay = findOverlayPackage(name, {
      installPackageUrl: pathToFileURL(desktopManifest(appDir)).href,
      profilePackageUrl: pathToFileURL(path.join(profileDir, 'package.json')).href,
    });
    const selected = overlay?.selected;
    if (selected === undefined) return { resolved: false, error: notFound(name) };
    return { resolved: true, source: selected.source, packageDir: selected.packageDir };
  } catch (error) {
    return { resolved: false, error };
  }
}

/** The exact error text the Host logs for an unresolvable row. */
export function notFound(name) {
  const error = new Error(
    `dsh-plugin-desktop: cannot resolve package ${JSON.stringify(name)} from the Desktop installation or active Profile`,
  );
  error.name = 'PackageOverlayNotFoundError';
  return error;
}

/** Convenience: resolve several names in one call. */
export async function resolveProfilePackages(profileDir, names, appDir = DEFAULT_DESKTOP_APP_DIR) {
  const findOverlayPackage = await loadFindOverlayPackage(appDir);
  return new Map(names.map((name) => [name, selectOverlayPackage(findOverlayPackage, profileDir, name, appDir)]));
}
