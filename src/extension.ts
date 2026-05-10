import * as vscode from 'vscode';
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

            await runner.scan(workspaceFolder);
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
