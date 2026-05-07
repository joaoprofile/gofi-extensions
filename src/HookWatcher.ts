import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HookEvent } from './types';

export class HookWatcher implements vscode.Disposable {
  private readonly _onEvent = new vscode.EventEmitter<HookEvent>();
  readonly onEvent = this._onEvent.event;

  private _watcher: fs.FSWatcher | null = null;
  private _offset = 0;
  private _logPath: string;

  constructor(logPath?: string) {
    const configured = vscode.workspace.getConfiguration('gofi').get<string>('hookEventsPath', '');
    this._logPath = logPath ?? configured ?? path.join(os.homedir(), '.claude', 'gofi-events.jsonl');
  }

  get logPath(): string { return this._logPath; }

  start(): void {
    this._tryWatch();
  }

  private _tryWatch(): void {
    try {
      // Seed offset to end of current file (skip historical events)
      if (fs.existsSync(this._logPath)) {
        this._offset = fs.statSync(this._logPath).size;
      }

      // Watch the parent directory so we catch the file being created
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) { return; }

      this._watcher = fs.watch(dir, (eventType, filename) => {
        if (filename && path.join(dir, filename) === this._logPath) {
          this._readNewLines();
        }
      });

      this._watcher.on('error', () => { /* silently ignore watch errors */ });
    } catch {
      // Hook file/dir doesn't exist yet — that's fine, hooks are optional
    }
  }

  private _readNewLines(): void {
    try {
      const stat = fs.statSync(this._logPath, { throwIfNoEntry: false });
      if (!stat || stat.size <= this._offset) { return; }

      const fd = fs.openSync(this._logPath, 'r');
      const buf = Buffer.alloc(stat.size - this._offset);
      fs.readSync(fd, buf, 0, buf.length, this._offset);
      fs.closeSync(fd);
      this._offset = stat.size;

      const lines = buf.toString('utf8').split('\n').filter(l => l.trim() !== '');
      for (const line of lines) {
        try {
          const event: HookEvent = JSON.parse(line);
          this._onEvent.fire(event);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file may have been rotated or deleted */ }
  }

  dispose(): void {
    this._watcher?.close();
    this._watcher = null;
    this._onEvent.dispose();
  }
}
