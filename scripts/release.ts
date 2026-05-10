import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

interface PackageJson {
    name: string;
    version: string;
}

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
});

async function main(): Promise<void> {
    const packageJson = readPackageJson();
    const version = await releaseVersion(packageJson.version);
    const vsixPath = path.join(root, `${packageJson.name}-${version}.vsix`);
    const releaseNotes = changelogEntry(version);

    updatePackageVersion(version);
    run('npm', ['run', 'package']);

    if (!fs.existsSync(vsixPath)) {
        fail(`Expected package output not found: ${vsixPath}`);
    }

    const notesPath = path.join(os.tmpdir(), `${packageJson.name}-${version}-release-notes.md`);
    fs.writeFileSync(notesPath, releaseNotes);

    await confirmReleaseNotes(version, releaseNotes);
    const targetSha = commitVersionUpdate(version);

    const ghArgs = [
        'release',
        'create',
        version,
        vsixPath,
        '--title',
        version,
        '--notes-file',
        notesPath,
        '--target',
        targetSha,
    ];

    if (dryRun) {
        console.log(`[dry-run] gh ${ghArgs.map(shellQuote).join(' ')}`);
    } else {
        run('gh', ghArgs);
    }
}

async function confirmReleaseNotes(version: string, releaseNotes: string): Promise<void> {
    console.log(`\nRelease notes for ${version}:\n`);
    console.log(releaseNotes);
    console.log('');

    if (dryRun) {
        return;
    }

    const answer = await prompt('Create GitHub release with these notes? [y/N] ');
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        fail('Release cancelled.');
    }
}

function commitVersionUpdate(version: string): string {
    runOrPrint('git', ['add', 'package.json', 'package-lock.json']);
    runOrPrint('git', ['commit', '-m', version]);
    const targetSha = dryRun ? '<release-commit-sha>' : capture('git', ['rev-parse', 'HEAD']);
    runOrPrint('git', ['push']);
    return targetSha;
}

function readPackageJson(): PackageJson {
    const packagePath = path.join(root, 'package.json');
    return JSON.parse(fs.readFileSync(packagePath, 'utf8')) as PackageJson;
}

async function releaseVersion(currentVersion: string): Promise<string> {
    const versionArg = argumentValue('--version');
    const version = versionArg ?? await prompt(`Release version (${currentVersion}): `);
    const normalized = version.trim().replace(/^v/, '');

    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
        fail(`Invalid semver version: ${version}`);
    }

    return normalized;
}

function updatePackageVersion(version: string): void {
    updateJsonFile(path.join(root, 'package.json'), (json: PackageJson) => {
        json.version = version;
        return json;
    });

    updateJsonFile(path.join(root, 'package-lock.json'), (json: PackageLockJson) => {
        json.version = version;
        if (json.packages?.['']) {
            json.packages[''].version = version;
        }
        return json;
    });
}

interface PackageLockJson {
    version: string;
    packages?: {
        '': {
            version: string;
        };
    };
}

function updateJsonFile<T>(filePath: string, update: (json: T) => T): void {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    fs.writeFileSync(filePath, `${JSON.stringify(update(json), null, 2)}\n`);
}

function changelogEntry(targetVersion: string): string {
    const changelogPath = path.join(root, 'CHANGELOG.md');
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    const headingPattern = /^##\s+(.+?)\s*$/gm;
    let match: RegExpExecArray | null;

    while ((match = headingPattern.exec(changelog)) !== null) {
        if (match[1] !== targetVersion) {
            continue;
        }

        const start = headingPattern.lastIndex;
        const next = headingPattern.exec(changelog);
        const end = next ? next.index : changelog.length;
        const entry = changelog.slice(start, end).trim();

        if (!entry) {
            fail(`CHANGELOG.md entry for ${targetVersion} is empty.`);
        }

        return entry;
    }

    fail(`No CHANGELOG.md entry found for ${targetVersion}.`);
}

function run(command: string, args: string[]): void {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: false,
    });

    if (result.error) {
        fail(`Failed to run ${command}: ${result.error.message}`);
    }

    if (result.status !== 0) {
        fail(`${command} exited with code ${result.status}.`);
    }
}

function capture(command: string, args: string[]): string {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        shell: false,
    });

    if (result.error) {
        fail(`Failed to run ${command}: ${result.error.message}`);
    }

    if (result.status !== 0) {
        fail(`${command} exited with code ${result.status}.`);
    }

    return result.stdout.trim();
}

function runOrPrint(command: string, args: string[]): void {
    if (dryRun) {
        console.log(`[dry-run] ${command} ${args.map(shellQuote).join(' ')}`);
        return;
    }

    run(command, args);
}

function argumentValue(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return undefined;
    }

    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) {
        fail(`Missing value for ${name}.`);
    }

    return value;
}

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function shellQuote(value: string): string {
    return value.includes(' ') ? JSON.stringify(value) : value;
}
