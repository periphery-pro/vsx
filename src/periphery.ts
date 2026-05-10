import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { findIndexStore } from './indexStore';

// ---------------------------------------------------------------------------
// Periphery JSON output types
// ---------------------------------------------------------------------------

/**
 * A single result entry emitted by `periphery scan --format json`.
 *
 * Example:
 * ```json
 * {
 *   "kind": "warning",
 *   "name": "MyUnusedClass",
 *   "modifiers": ["public"],
 *   "attributes": [],
 *   "accessibility": "public",
 *   "hints": ["unused"],
 *   "location": "Sources/App/MyClass.swift:42:5"
 * }
 * ```
 */
interface PeripheryResult {
    kind: 'warning' | 'error' | string;
    name: string;
    modifiers: string[];
    attributes: string[];
    accessibility: string;
    hints: string[];
    /** Format: "relative/or/absolute/path.swift:line:column" */
    location: string;
}

// ---------------------------------------------------------------------------
// PeripheryRunner
// ---------------------------------------------------------------------------

export class PeripheryRunner {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly output: vscode.OutputChannel;
    private running = false;

    constructor(
        diagnostics: vscode.DiagnosticCollection,
        output: vscode.OutputChannel
    ) {
        this.diagnostics = diagnostics;
        this.output = output;
    }

    log(message: string): void {
        this.output.appendLine(`[Periphery] ${message}`);
    }

    /**
     * Run `periphery scan` for the given workspace folder and publish results
     * to the Problems pane.
     *
     * @param folder  The workspace folder that owns the Swift package.
     */
    async scan(folder: vscode.WorkspaceFolder): Promise<void> {
        if (this.running) {
            this.log('A scan is already in progress; skipping.');
            return;
        }

        this.running = true;
        this.diagnostics.clear();

        try {
            await this.doScan(folder);
        } finally {
            this.running = false;
        }
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private async doScan(folder: vscode.WorkspaceFolder): Promise<void> {
        const config = vscode.workspace.getConfiguration('periphery', folder.uri);
        const executablePath = config.get<string>('executablePath', 'periphery');

        const workspaceRoot = folder.uri.fsPath;

        // Locate the index store produced by the Swift extension build.
        const indexStoreResult = findIndexStore(workspaceRoot, '.build');
        if (!indexStoreResult) {
            this.log(
                'Index store not found under ".build". ' +
                'Build the package with the Swift extension first.'
            );
            vscode.window.showWarningMessage(
                'Periphery: No index store found. Build the Swift package first.'
            );
            return;
        }

        this.log(`Using index store: ${indexStoreResult.path}`);

        const args = [
            'scan',
            '--skip-build',
            '--index-store-path', indexStoreResult.path,
            '--format', 'json',
        ];

        this.log(`Running: ${executablePath} ${args.join(' ')}`);
        let stdout: string;
        let stderr: string;

        try {
            ({ stdout, stderr } = await runProcess(executablePath, args, workspaceRoot));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`Failed to run periphery: ${message}`);
            vscode.window.showErrorMessage(`Periphery: ${message}`);
            return;
        }

        if (stderr.trim()) {
            this.log(stderr);
        }

        // Parse and publish diagnostics.
        let results: PeripheryResult[];
        try {
            results = parsePeripheryOutput(stdout);
        } catch (err) {
            this.log(`Failed to parse output: ${err instanceof Error ? err.message : err}`);
            this.log('Raw stdout:');
            this.log(stdout);
            vscode.window.showErrorMessage(
                'Periphery: Failed to parse scan results. Check the Periphery output channel.'
            );
            return;
        }

        this.publishDiagnostics(results, workspaceRoot);

        const count = results.length;
        const noun = count === 1 ? 'issue' : 'issues';
        this.log(`Scan complete — ${count} ${noun} found.`);

        if (count > 0) {
            vscode.window.showInformationMessage(
                `Periphery: ${count} unused code ${noun} found.`,
                'Show Problems'
            ).then((choice) => {
                if (choice === 'Show Problems') {
                    vscode.commands.executeCommand('workbench.actions.view.problems');
                }
            });
        } else {
            vscode.window.showInformationMessage('Periphery: No unused code found.');
        }
    }

    /**
     * Convert Periphery results into VS Code diagnostics and populate the
     * diagnostic collection (which feeds the Problems pane).
     */
    private publishDiagnostics(
        results: PeripheryResult[],
        workspaceRoot: string
    ): void {
        // Group by file URI so we make a single setDiagnostics call per file.
        const byUri = new Map<string, vscode.Diagnostic[]>();

        for (const result of results) {
            const location = parseLocation(result.location, workspaceRoot);
            if (!location) {
                this.log(`Could not parse location "${result.location}" — skipping.`);
                continue;
            }

            const { uri, range } = location;
            const key = uri.toString();

            if (!byUri.has(key)) {
                byUri.set(key, []);
            }

            const diagnostic = buildDiagnostic(result, range);
            byUri.get(key)!.push(diagnostic);
        }

        for (const [uriString, diags] of byUri) {
            this.diagnostics.set(vscode.Uri.parse(uriString), diags);
        }
    }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Parses the JSON array emitted by `periphery scan --format json`.
 * Periphery writes the entire result set as a single JSON array.
 */
function parsePeripheryOutput(stdout: string): PeripheryResult[] {
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') {
        return [];
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
        throw new Error('Expected a JSON array from periphery scan --format json');
    }

    return parsed as PeripheryResult[];
}

// ---------------------------------------------------------------------------
// Location parsing
// ---------------------------------------------------------------------------

interface ResolvedLocation {
    uri: vscode.Uri;
    range: vscode.Range;
}

/**
 * Parses a Periphery location string of the form `path/to/File.swift:line:column`
 * into a VS Code URI and zero-based Range.
 *
 * The path may be absolute or relative to `workspaceRoot`.
 */
function parseLocation(
    location: string,
    workspaceRoot: string
): ResolvedLocation | undefined {
    // Periphery format: "/absolute/path/File.swift:42:5"
    // We split from the right to handle Windows drive letters and colons in paths.
    const match = location.match(/^(.*):(\d+):(\d+)$/);
    if (!match) {
        return undefined;
    }

    const [, filePath, lineStr, colStr] = match;
    const line = parseInt(lineStr, 10) - 1; // VS Code lines are 0-based
    const col = parseInt(colStr, 10) - 1;   // VS Code columns are 0-based

    if (line < 0 || col < 0) {
        return undefined;
    }

    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspaceRoot, filePath);

    const uri = vscode.Uri.file(absolutePath);
    const position = new vscode.Position(line, col);
    const range = new vscode.Range(position, position);

    return { uri, range };
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

/**
 * Builds a VS Code Diagnostic from a Periphery result entry.
 */
function buildDiagnostic(
    result: PeripheryResult,
    range: vscode.Range
): vscode.Diagnostic {
    const severity = result.kind === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;

    const message = buildMessage(result);

    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = 'Periphery';
    diagnostic.code = result.hints.join(', ') || 'unused';

    return diagnostic;
}

/**
 * Produces a human-readable message for the Problems pane entry.
 *
 * Examples:
 *   "MyClass is unused"
 *   "myProperty is assigned but never read"
 *   "public class MyClass is unused"
 */
function buildMessage(result: PeripheryResult): string {
    const hintDescription = describeHints(result.hints);
    return `'${result.name}' ${hintDescription}`;
}

function describeHints(hints: string[]): string {
    if (hints.length === 0) {
        return 'is unused';
    }

    const descriptions: Record<string, string> = {
        unused: 'is unused',
        assignOnlyProperty: 'is assigned but never read',
        redundantProtocolConformance: 'has a redundant protocol conformance',
        redundantPublicAccessibility: 'is public but not used outside the module',
    };

    const mapped = hints
        .map((h) => descriptions[h] ?? h.replace(/([A-Z])/g, ' $1').toLowerCase().trim())
        .join('; ');

    return mapped;
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

interface ProcessResult {
    stdout: string;
    stderr: string;
}

/**
 * Runs a child process and returns its stdout/stderr.
 * Rejects if the process cannot be spawned or exits with a non-zero code
 * that is not Periphery's "findings found" exit code (1).
 */
function runProcess(
    executable: string,
    args: string[],
    cwd: string
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(executable, args, {
            cwd,
            env: process.env,
            shell: false,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                reject(
                    new Error(
                        `"${executable}" not found. Install Periphery and ensure it is on $PATH, ` +
                        'or set "periphery.executablePath" in settings.'
                    )
                );
            } else {
                reject(new Error(`Failed to spawn periphery: ${err.message}`));
            }
        });

        child.on('close', (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');

            // Periphery exits 0 when no issues are found, 1 when issues are found.
            // Any other exit code is a genuine error.
            if (code !== null && code > 1) {
                reject(
                    new Error(
                        `periphery exited with code ${code}. ` +
                        `stderr: ${stderr.trim() || '(empty)'}`
                    )
                );
                return;
            }

            resolve({ stdout, stderr });
        });
    });
}
