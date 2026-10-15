// Resolve the REAL `@deepseek-ai/dsh-session` implementation, wherever it lives.
//
// The fork-window tests validate seeds against the real `Session` class, so they
// need a genuine implementation — a stub would only prove the test agrees with
// itself. That package is normally a transitive dependency of the plugin's
// devDependencies (`@deepseek-ai/dsh-settings` / `dsh-subagent`), so `npm install`
// followed by a plain `require` is the primary path.
//
// DSH Desktop, however, ships its host packages INSIDE `resources/app.asar`,
// which plain Node cannot resolve through the ordinary module algorithm. On a
// machine where the repo is checked out without installing, the only copy may be
// inside that archive. Resolution order, most-specific first:
//
//   1. `DSH_SESSION_PATH` — an explicit override, for unusual installs.
//   2. A plain `require("@deepseek-ai/dsh-session")` — the installed dependency
//      (CI and any machine that ran `npm install`).
//   3. `DSH_HOME` / `~/.dsh/profiles/<profile>/node_modules/...` — a profile
//      whose own install happens to carry the package.
//   4. The platform default DSH Desktop location, with `app.asar/dsh` as the
//      package root (`resources/app.asar/dsh/node_modules/@deepseek-ai/...`).
//
// When none of them yields a usable module the tests SKIP rather than fail.
// That is deliberate: a contributor without DSH Desktop installed must still be
// able to run `npm test` and see the other two suites pass. A test that cannot
// reach its subject is not a failing test — reporting it as one trains people to
// ignore red output, which is worse than an honest skip.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const PACKAGE = "@deepseek-ai/dsh-session";

/** Candidate absolute paths to a DSH Desktop host install (no trailing slash). */
function candidatePaths() {
	const candidates = [];

	const dshHome = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
	const profilesRoot = path.join(dshHome, "profiles");
	for (const profile of ["desktop", "web", "default"]) {
		candidates.push(path.join(profilesRoot, profile, "node_modules", ...PACKAGE.split("/")));
	}

	if (platform() === "win32") {
		const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		const appRoot = path.join(local, "Programs", "DeepSeek Harness", "resources");
		candidates.push(path.join(appRoot, "app.asar", "dsh", "node_modules", ...PACKAGE.split("/")));
		candidates.push(path.join(appRoot, "app", "dsh", "node_modules", ...PACKAGE.split("/")));
	} else if (platform() === "darwin") {
		const appRoot = "/Applications/DeepSeek Harness.app/Contents/Resources";
		candidates.push(path.join(appRoot, "app.asar", "dsh", "node_modules", ...PACKAGE.split("/")));
		candidates.push(path.join(appRoot, "app", "dsh", "node_modules", ...PACKAGE.split("/")));
	} else {
		for (const appRoot of ["/opt/DeepSeek Harness/resources", "/usr/lib/deepseek-harness/resources"]) {
			candidates.push(path.join(appRoot, "app.asar", "dsh", "node_modules", ...PACKAGE.split("/")));
			candidates.push(path.join(appRoot, "app", "dsh", "node_modules", ...PACKAGE.split("/")));
		}
	}

	return candidates;
}

/**
 * Load the real `Session` class, or `undefined` when no installation is
 * reachable. Callers should skip their assertions in the latter case.
 */
export function loadRealSession() {
	const explicit = process.env.DSH_SESSION_PATH;
	if (explicit) {
		try {
			const mod = require(explicit);
			if (mod?.Session) return { Session: mod.Session, source: explicit };
		} catch {
			// An explicit override that does not load is a user error, but falling
			// through to the ordinary resolution order is friendlier than throwing.
		}
	}

	// Installed dependency: the normal path after `npm install`, and what CI uses.
	try {
		const mod = require(PACKAGE);
		if (mod?.Session) return { Session: mod.Session, source: PACKAGE };
	} catch {
		// Not installed as an ordinary dependency; try the host installs below.
	}

	for (const candidate of candidatePaths()) {
		try {
			if (!existsSync(candidate)) continue;
			const mod = require(candidate);
			if (mod?.Session) return { Session: mod.Session, source: candidate };
		} catch {
			// A candidate that exists but cannot be loaded (wrong platform, partial
			// install, asar read failure) is simply not the one; keep looking.
		}
	}

	return void 0;
}

/** True when a real DSH `Session` is reachable on this machine. */
export function hasRealSession() {
	return loadRealSession() !== void 0;
}

export const SKIP_REASON =
	`real ${PACKAGE} is not reachable on this machine (DSH Desktop keeps it inside ` +
	`resources/app.asar). Set DSH_SESSION_PATH to its package directory to run this suite.`;
