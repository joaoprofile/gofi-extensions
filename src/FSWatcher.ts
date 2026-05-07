import * as vscode from 'vscode';
import * as path from 'path';
import { DiffTracker } from './DiffTracker';

export class FSWatcher implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _excludeGlobs: string[];

  constructor(private readonly _diffTracker: DiffTracker) {
    this._excludeGlobs = vscode.workspace.getConfiguration('gofi')
      .get<string[]>('excludeGlobs', ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**']);
  }

  start(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }

    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

      watcher.onDidChange(uri => this._schedule(uri, 'modified'), null, this._disposables);
      watcher.onDidCreate(uri => this._schedule(uri, 'created'), null, this._disposables);
      watcher.onDidDelete(uri => this._schedule(uri, 'deleted'), null, this._disposables);

      this._disposables.push(watcher);
    }

    // Seed cache for already-open documents
    vscode.workspace.textDocuments.forEach(doc => this._diffTracker.seedCache(doc));
    this._disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => this._diffTracker.seedCache(doc))
    );
  }

  private _schedule(uri: vscode.Uri, changeType: 'created' | 'modified' | 'deleted'): void {
    if (this._shouldExclude(uri.fsPath)) { return; }

    const key = `${changeType}:${uri.fsPath}`;
    const existing = this._debounceTimers.get(key);
    if (existing) { clearTimeout(existing); }

    // Debounce rapid successive events for the same file (100ms)
    const timer = setTimeout(() => {
      this._debounceTimers.delete(key);
      this._diffTracker.handleFileEvent(uri, changeType);
    }, 100);

    this._debounceTimers.set(key, timer);
  }

  private _shouldExclude(fsPath: string): boolean {
    const normalized = fsPath.replace(/\\/g, '/');
    return this._excludeGlobs.some(glob => {
      // Convert common glob patterns to simple substring checks
      const pattern = glob.replace(/\*\*\//g, '').replace(/\//g, path.sep);
      if (glob.startsWith('**/') && glob.endsWith('/**')) {
        const segment = glob.slice(3, -3);
        return normalized.includes('/' + segment + '/') || normalized.includes('/' + segment);
      }
      if (glob.startsWith('**/')) {
        const suffix = glob.slice(3);
        return normalized.endsWith('/' + suffix) || path.basename(fsPath) === suffix;
      }
      return normalized.includes(pattern);
    });
  }

  dispose(): void {
    for (const t of this._debounceTimers.values()) { clearTimeout(t); }
    this._debounceTimers.clear();
    this._disposables.forEach(d => d.dispose());
  }
}
