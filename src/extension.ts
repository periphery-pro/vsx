import * as vscode from 'vscode';
import type { SwiftBuildConfiguration } from './indexStore';
import { PeripheryRunner } from './periphery';

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Periphery');
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('periphery');

    context.subscriptions.push(outputChannel, diagnosticCollection);

    const runner = new PeripheryRunner(diagnosticCollection, outputChannel);

    // Watch for Swift package build tasks completing successfully and trigger a scan.
    context.subscriptions.push(
        vscode.tasks.onDidEndTaskProcess(async (event) => {
            const config = vscode.workspace.getConfiguration('periphery');
            if (!config.get<boolean>('scanOnBuild', true)) {
                return;
            }

            if (event.exitCode !== 0) {
                return;
            }

            if (!isSwiftBuildTask(event.execution.task)) {
                return;
            }

            const workspaceFolder = taskWorkspaceFolder(event.execution.task);
            if (!workspaceFolder) {
                return;
            }

            await runner.scan(
                workspaceFolder,
                swiftBuildConfiguration(event.execution.task)
            );
        })
    );

    // Manual scan command.
    context.subscriptions.push(
        vscode.commands.registerCommand('periphery.scan', async () => {
            const folder = await pickWorkspaceFolder();
            if (!folder) {
                return;
            }
            await runner.scan(folder);
        })
    );

    // Clear results command.
    context.subscriptions.push(
        vscode.commands.registerCommand('periphery.clear', () => {
            diagnosticCollection.clear();
            runner.log('Results cleared.');
        })
    );
}

export function deactivate(): void {
    // Subscriptions are disposed automatically by VS Code.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `task` was produced by the official Swift VS Code extension
 * (vscode-swift) and represents a build step.
 */
function isSwiftBuildTask(task: vscode.Task): boolean {
    if (task.source !== 'swift') {
        return false;
    }

    const isBuildGroup =
        task.group === vscode.TaskGroup.Build ||
        task.group?.id === vscode.TaskGroup.Build.id;

    return isBuildGroup && task.name.toLowerCase().includes('build');
}

/**
 * Detects the SwiftPM configuration that the Swift extension used for a build
 * task. Release builds are explicit; debug builds are usually the default.
 */
function swiftBuildConfiguration(task: vscode.Task): SwiftBuildConfiguration {
    return (
        configurationFromSwiftArgs(task.definition.args) ??
        configurationFromText(`${task.name} ${task.detail ?? ''}`) ??
        'debug'
    );
}

function configurationFromSwiftArgs(args: unknown): SwiftBuildConfiguration | undefined {
    if (!Array.isArray(args)) {
        return undefined;
    }

    for (let i = 0; i < args.length; i++) {
        const normalized = stringArg(args[i])?.toLowerCase();
        if (!normalized) {
            continue;
        }

        if (normalized === '-c' || normalized === '--configuration') {
            return configurationFromText(stringArg(args[i + 1]) ?? '');
        }

        const inlineMatch = normalized.match(/^(?:-c=?|--configuration=)(debug|release)$/);
        if (inlineMatch) {
            return inlineMatch[1] as SwiftBuildConfiguration;
        }
    }

    return undefined;
}

function configurationFromText(text: string): SwiftBuildConfiguration | undefined {
    const normalized = text.toLowerCase();
    if (/\brelease\b/.test(normalized)) {
        return 'release';
    }
    if (/\bdebug\b/.test(normalized)) {
        return 'debug';
    }
    return undefined;
}

function stringArg(arg: unknown): string | undefined {
    return typeof arg === 'string' ? arg : undefined;
}

/**
 * Returns the workspace folder associated with the task scope, if any.
 */
function taskWorkspaceFolder(task: vscode.Task): vscode.WorkspaceFolder | undefined {
    if (task.scope && typeof task.scope === 'object' && 'uri' in task.scope) {
        return task.scope as vscode.WorkspaceFolder;
    }

    // Fall back to the first workspace folder when scope is global/undefined.
    return vscode.workspace.workspaceFolders?.[0];
}

/**
 * Prompts the user to pick a workspace folder when multiple are open;
 * returns the single folder immediately when only one is open.
 */
async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('Periphery: No workspace folder is open.');
        return undefined;
    }

    if (folders.length === 1) {
        return folders[0];
    }

    return vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Select the Swift package to scan',
    });
}
