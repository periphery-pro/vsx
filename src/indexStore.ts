import * as fs from 'fs';
import * as path from 'path';

/**
 * Candidate index store sub-paths relative to the Swift build path.
 *
 * Swift Package Manager places the index store under:
 *   <buildPath>/<variant>/index/store   (Swift 5.4+)
 *   <buildPath>/index/store             (some older toolchains)
 *
 * We also check the release variant because a release build would write to
 * a different directory than a debug build.
 */
const INDEX_STORE_CANDIDATES: ReadonlyArray<string> = [
    'debug/index/store',
    'release/index/store',
    'index/store',
];

export interface IndexStoreResult {
    /** Absolute path to the index store directory. */
    path: string;
    /** Wall-clock time (ms since epoch) of the newest entry in the store. */
    mtime: number;
}

/**
 * Locates the most recently modified index store under `buildPath`.
 *
 * @param workspaceRoot  Absolute path to the workspace (package) root.
 * @param buildPath      Relative or absolute path to the Swift build folder.
 * @returns The best matching index store, or `undefined` if none exists.
 */
export function findIndexStore(
    workspaceRoot: string,
    buildPath: string
): IndexStoreResult | undefined {
    const absoluteBuildPath = path.isAbsolute(buildPath)
        ? buildPath
        : path.join(workspaceRoot, buildPath);

    let best: IndexStoreResult | undefined;

    for (const candidate of INDEX_STORE_CANDIDATES) {
        const storePath = path.join(absoluteBuildPath, candidate);
        if (!isDirectory(storePath)) {
            continue;
        }

        const mtime = directoryMtime(storePath);
        if (!best || mtime > best.mtime) {
            best = { path: storePath, mtime };
        }
    }

    return best;
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Returns the most recent `mtime` among the direct children of `dirPath`,
 * falling back to the directory's own mtime if it is empty.
 */
function directoryMtime(dirPath: string): number {
    try {
        const stat = fs.statSync(dirPath);
        let newest = stat.mtimeMs;

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            try {
                const childStat = fs.statSync(path.join(dirPath, entry.name));
                if (childStat.mtimeMs > newest) {
                    newest = childStat.mtimeMs;
                }
            } catch {
                // ignore inaccessible entries
            }
        }
        return newest;
    } catch {
        return 0;
    }
}
