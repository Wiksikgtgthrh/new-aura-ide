import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class AuraWebviewViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        
        const htmlPath = vscode.Uri.file(path.join(this.extensionUri.fsPath, 'src', 'webview', 'template.html'));
        webviewView.webview.html = fs.readFileSync(htmlPath.fsPath, 'utf8');

        webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === 'refresh') {
                vscode.commands.executeCommand('auraTeam.refresh');
            }
        });
    }

    update(tasks: any[]): void {
        if (this.view) {
            this.view.webview.postMessage({ command: 'updateTasks', tasks });
        }
    }
}
