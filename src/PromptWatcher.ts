import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Watches ~/.claude/projects/<workspace-hash>/*.jsonl for new last-prompt entries.
 * Claude Code appends {"type":"last-prompt","lastPrompt":"..."} each time the user
 * submits a message, so we can capture it without any manual paste.
 */
export class PromptWatcher implements vscode.Disposable {
  private readonly _onPrompt = new vscode.EventEmitter<string>();
  readonly onPrompt = this._onPrompt.event;

  private readonly _offsets = new Map<string, number>();
  private _watcher: fs.FSWatcher | null = null;
  private _sessionDir: string | null = null;

  start(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }

    const workspacePath = folders[0].uri.fsPath;
    // Claude Code derives the project dir by replacing all / with -
    // e.g. /home/user/myapp  →  ~/.claude/projects/-home-user-myapp
    const projectHash = workspacePath.replace(/\//g, '-');
    this._sessionDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

    if (!fs.existsSync(this._sessionDir)) { return; }

    // Seed offsets to current file end so we only see NEW prompts
    this._seedOffsets();

    this._watcher = fs.watch(this._sessionDir, (_evt, filename) => {
      if (filename?.endsWith('.jsonl')) {
        this._readNewLines(path.join(this._sessionDir!, filename));
      }
    });

    this._watcher.on('error', () => { /* ignore — watch may not be available */ });
  }

  private _seedOffsets(): void {
    if (!this._sessionDir) { return; }
    try {
      fs.readdirSync(this._sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .forEach(f => {
          const fp = path.join(this._sessionDir!, f);
          const stat = fs.statSync(fp, { throwIfNoEntry: false });
          if (stat) { this._offsets.set(fp, stat.size); }
        });
    } catch { /* dir may be unreadable */ }
  }

  private _readNewLines(filePath: string): void {
    try {
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (!stat) { return; }

      const offset = this._offsets.get(filePath) ?? 0;
      if (stat.size <= offset) { return; }

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      this._offsets.set(filePath, stat.size);

      const lines = buf.toString('utf8').split('\n').filter(l => l.trim() !== '');
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'last-prompt' && typeof entry.lastPrompt === 'string' && entry.lastPrompt.trim()) {
            this._onPrompt.fire(entry.lastPrompt);
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file may have been rotated */ }
  }

  dispose(): void {
    this._watcher?.close();
    this._watcher = null;
    this._onPrompt.dispose();
  }
}
