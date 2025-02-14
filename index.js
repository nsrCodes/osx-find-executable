const childProcess = require('child_process');
const join = require('path').join;
const rawParsePlist = require('plist').parse;
const bplist = require('bplist-parser');
const { promisify } = require('util');
const fs = require('fs');
const { isBinary } = require('istextorbinary');

const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const exec = promisify(childProcess.exec);

const parsePlist = (plistData) => {
    // Wrap plist warnings, to silence all non-fatal xmldom errors:
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = function (msg) {
        if (msg && msg.startsWith && msg.startsWith('[xmldom error]')) return;
        else return originalError.apply(this, arguments);
    };

    try {
        return rawParsePlist(plistData);
    } finally {
        console.warn = originalWarn;
        console.error = originalError;
    }
};

let isSpotlightAvailable = null; // null | Promise | true | false
let spotlightAppIndex = null; // null | Promise | { bundleId -> plistData }

function checkSpotlightAvailable() {
    if (typeof isSpotlightAvailable === 'boolean') {
        return Promise.resolve(isSpotlightAvailable); // We've already checked
    }

    if (isSpotlightAvailable === null) {
        // Check if indexing is enabled, and persist the ongoing check as a promise
        // in isSpotlightAvailable, to avoid parallel checks.
        isSpotlightAvailable = exec('mdutil -s /').then((result) => {
            isSpotlightAvailable = !result.stdout.includes('Indexing disabled');
            return isSpotlightAvailable;
        });
    }

    // Returns an ongoing check (which we either just started, or started earlier)
    return isSpotlightAvailable;
}

async function buildAppIndex() {
    const appDirs = await getApplicationFolders('/Applications');

    const apps = await Promise.all(appDirs.map(async (appDir) => ({
        plist: await getPlistData(appDir).catch(() => undefined),
        appPath: appDir
    })));

    const index = {};
    apps.forEach((app) => {
        if (app.plist && app.plist.CFBundleIdentifier && app.plist.CFBundleExecutable) {
            index[app.plist.CFBundleIdentifier] = app; // If we do get a conflict, just use the last result
        }
    });

    return index;
}

async function findExecutableManually(bundleId) {
    spotlightAppIndex = spotlightAppIndex || buildAppIndex();

    const matchingApp = (await spotlightAppIndex)[bundleId];
    if (!matchingApp) return;

    const { appPath, plist } = matchingApp;
    return getExecutablePath(appPath, plist);
}

async function getApplicationFolders(root) {
    try {
        const fileEntries = await readdir(root, { withFileTypes: true });
        const dirs = fileEntries.filter(e => e.isDirectory());

        const [appDirs, nonAppDirs] = dirs.reduce((acc, entry) => {
            const path = join(root, entry.name);
            if (entry.name.endsWith('.app')) {
                acc[0].push(path);
            } else {
                acc[1].push(path);
            }
            return acc;
        }, [[], []]);

        return appDirs.concat(
            ...await Promise.all(
                // Recurse into any non-.app folders
                nonAppDirs.map((dir) => getApplicationFolders(dir))
            )
        );
    } catch (e) {
        console.log(e);
        return [];
    }
}

async function getPlistData(appDir) {
    const data = await readFile(join(appDir, 'Contents', 'Info.plist'), 'utf8');
    return parsePlist(data);
}

function getExecutablePath(appDir, plist) {
    return join(appDir, 'Contents', 'MacOS', plist?.CFBundleExecutable)
}

exports.findExecutableInApp = async function findExecutableInApp(appDir) {
    const plist = await getPlistData(appDir);
    return getExecutablePath(appDir, plist);
}

exports.findExecutableById = async function findExecutableById(bundleId) {
    if (isSpotlightAvailable === false) {
        // If we already know for sure that spotlight isn't available:
        const executablePath = await findExecutableManually(bundleId)
        if (executablePath) {
            return executablePath;
        } else {
            throw Error(`Not installed: ${bundleId}`);
        }
    }

    // If spotlight is available, or we just don't know yet:
    let result = await exec(`mdfind "kMDItemCFBundleIdentifier=="${bundleId}""`).catch(e => e);

    if (result instanceof Error) {
        // Result is an error:

        if (result.code === 127) {
            // We can't call mdfind: we can't use spotlight
            isSpotlightAvailable = false;
            // Retry: this will now search manually instead
            return exports.findExecutableById(bundleId);
        }

        // Otherwise, continue as 'not found' (probably still fails, but might successfully
        // fall back to a manual search if spotlight is clearly disabled).
        result = { stdout: '' };
    }

    const path = result
        .stdout
        .trim()
        .split('\n')[0]; // If there are multiple results, use the first

    if (!path) {
        if (!await checkSpotlightAvailable()) {
            // If we now know it's not available, try again (i.e. try manually)
            return exports.findExecutableById(bundleId);
        } else {
            throw new Error(`Not installed: ${bundleId}`);
        }
    }

    let plist;
    const plistFilePath = join(path, 'Contents', 'Info.plist')
    // sometimes this file is of type `Apple binary property list` instead of normal ASCII text
    if (isBinary(null, fs.readFileSync(plistFilePath))) {
        const plistContents = await bplist.parseFile(plistFilePath)
        plist = plistContents[0]
    } else {
        const rawPlistContents = await readFile(plistFilePath, 'utf8');
        plist = parsePlist(rawPlistContents);
    }
    return getExecutablePath(path, plist);
}
