import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PromptDetection } from './types';

/**
 * Watches ~/.claude/projects/<workspace-hash>/*.jsonl for new user text messages.
 * Claude Code appends {"type":"user","message":{"content":[{"type":"text","text":"..."}]}}
 * each time the user submits a prompt, so we can capture it without any manual paste.
 *
 * When a new prompt is detected, emits both the bare prompt text and a formatted
 * conversation context (last 4 turns) so the scorer can judge clarity/completeness
 * relative to what was already established in the session.
 */
export class PromptWatcher implements vscode.Disposable {
  private readonly _onPrompt = new vscode.EventEmitter<PromptDetection>();
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
          // Claude Code JSONL: user text messages have type='user' with text content blocks.
          // Tool results also have type='user' but their content blocks are type='tool_result'.
          if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
            const textBlocks: Array<{ type: string; text: string }> = entry.message.content.filter(
              (c: { type: string }) => c.type === 'text'
            );
            if (textBlocks.length > 0) {
              const text = textBlocks.map(c => c.text).join('\n').trim();
              if (text) {
                const context = this._buildContext(filePath, entry.sessionId as string | undefined);
                // fileOffset = byte position just before this batch so the tracker can
                // measure everything Claude consumed after the prompt was submitted.
                this._onPrompt.fire({ prompt: text, context, filePath, fileOffset: offset });
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file may have been rotated */ }
  }

  /**
   * Reads the full JSONL file and returns the last 4 conversation turns
   * (user + assistant pairs) formatted as plain text for the scorer.
   * Assistant messages are truncated to their first 200 chars since the
   * code they write isn't relevant to judging prompt clarity.
   */
  private _buildContext(filePath: string, sessionId: string | undefined): string {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const turns: Array<{ role: 'User' | 'Assistant'; text: string }> = [];

      for (const line of content.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const entry = JSON.parse(line);
          if (sessionId && entry.sessionId !== sessionId) { continue; }
          if (!Array.isArray(entry.message?.content)) { continue; }

          const textBlocks: Array<{ type: string; text: string }> = entry.message.content.filter(
            (c: { type: string }) => c.type === 'text'
          );
          if (!textBlocks.length) { continue; }

          const raw = textBlocks.map(c => c.text).join('\n').trim();
          if (!raw) { continue; }

          if (entry.type === 'user') {
            turns.push({ role: 'User', text: raw.slice(0, 600) });
          } else if (entry.type === 'assistant') {
            // Only keep the first sentence/paragraph — we don't need the full code output
            turns.push({ role: 'Assistant', text: raw.slice(0, 200) });
          }
        } catch { /* skip malformed */ }
      }

      // Keep the last 9 turns (≈4 full back-and-forth exchanges + the current prompt)
      const recent = turns.slice(-9);
      return recent.map(t => `${t.role}: ${t.text}`).join('\n\n');
    } catch {
      return '';
    }
  }

  dispose(): void {
    this._watcher?.close();
    this._watcher = null;
    this._onPrompt.dispose();
  }
}
