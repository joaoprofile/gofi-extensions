import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  ChangeType,
  DiffHunk,
  DiffLine,
  FileChange,
  HookEvent,
  SessionStats,
} from './types';
import { estimateCost, estimateTokens, rawDiffText } from './TokenEstimator';

// ─── LCS diff implementation ──────────────────────────────────────────────────

const MAX_DIFF_LINES = 2000;
const CONTEXT_LINES = 3;

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function backtrack(dp: number[][], a: string[], b: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'context', content: a[i - 1], lineNoOld: i, lineNoNew: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', content: b[j - 1], lineNoOld: null, lineNoNew: j });
      j--;
    } else {
      result.push({ type: 'removed', content: a[i - 1], lineNoOld: i, lineNoNew: null });
      i--;
    }
  }
  return result.reverse();
}

function buildHunks(lines: DiffLine[]): DiffHunk[] {
  const n = lines.length;
  const include = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (lines[i].type !== 'context') {
      const lo = Math.max(0, i - CONTEXT_LINES);
      const hi = Math.min(n - 1, i + CONTEXT_LINES);
      for (let c = lo; c <= hi; c++) { include[c] = true; }
    }
  }

  // Build contiguous ranges
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && include[i]) {
      if (start === -1) { start = i; }
    } else if (start !== -1) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }

  return ranges.map(([s, e]) => {
    const hunkLines = lines.slice(s, e + 1);
    const addedCount = hunkLines.filter(l => l.type === 'added').length;
    const removedCount = hunkLines.filter(l => l.type === 'removed').length;
    const firstOld = hunkLines.find(l => l.lineNoOld !== null)?.lineNoOld ?? 1;
    const firstNew = hunkLines.find(l => l.lineNoNew !== null)?.lineNoNew ?? 1;
    const oldCount = hunkLines.filter(l => l.lineNoOld !== null).length;
    const newCount = hunkLines.filter(l => l.lineNoNew !== null).length;
    const header = `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`;
    return { header, lines: hunkLines, addedCount, removedCount };
  });
}

export function computeDiff(oldText: string, newText: string): {
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
  skippedDiff: boolean;
} {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return {
      hunks: [],
      addedLines: newLines.length,
      removedLines: oldLines.length,
      skippedDiff: true,
    };
  }

  const dp = lcsTable(oldLines, newLines);
  const flat = backtrack(dp, oldLines, newLines);
  const hunks = buildHunks(flat);
  const addedLines = flat.filter(l => l.type === 'added').length;
  const removedLines = flat.filter(l => l.type === 'removed').length;

  return { hunks, addedLines, removedLines, skippedDiff: false };
}

// ─── DiffTracker ─────────────────────────────────────────────────────────────

export class DiffTracker implements vscode.Disposable {
  private readonly _cache = new Map<string, string>();
  private readonly _changes: FileChange[] = [];
  private readonly _onFileChange = new vscode.EventEmitter<FileChange>();
  private readonly _onConfidenceNeeded = new vscode.EventEmitter<FileChange>();

  private _isRunning: boolean;
  private _startTime: Date | null;

  readonly onFileChange = this._onFileChange.event;
  readonly onConfidenceNeeded = this._onConfidenceNeeded.event;

  constructor() {
    const autoStart = vscode.workspace.getConfiguration('gofi').get<boolean>('autoStart', true);
    this._isRunning = autoStart;
    this._startTime = autoStart ? new Date() : null;
  }

  get isRunning(): boolean { return this._isRunning; }
  get changes(): FileChange[] { return [...this._changes]; }

  get stats(): SessionStats {
    return {
      isRunning: this._isRunning,
      startTime: this._startTime?.toISOString() ?? null,
      durationMs: this._startTime ? Date.now() - this._startTime.getTime() : 0,
      fileChangeCount: this._changes.length,
      totalAddedLines: this._changes.reduce((s, c) => s + c.addedLines, 0),
      totalRemovedLines: this._changes.reduce((s, c) => s + c.removedLines, 0),
      totalEstimatedTokens: this._changes.reduce((s, c) => s + c.estimatedTokens, 0),
      totalEstimatedCostUsd: this._changes.reduce((s, c) => s + c.estimatedCostUsd, 0),
      uniqueFilesChanged: new Set(this._changes.map(c => c.filePath)).size,
    };
  }

  startSession(): void {
    this._isRunning = true;
    this._startTime = new Date();
  }

  stopSession(): void {
    this._isRunning = false;
  }

  clearSession(): void {
    this._changes.length = 0;
    this._isRunning = false;
    this._startTime = null;
  }

  seedCache(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') { return; }
    this._cache.set(doc.uri.fsPath, doc.getText());
  }

  async handleFileEvent(uri: vscode.Uri, changeType: ChangeType): Promise<void> {
    if (!this._isRunning) { return; }

    const oldContent = this._cache.get(uri.fsPath) ?? '';

    let newContent = '';
    if (changeType !== 'deleted') {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        newContent = new TextDecoder().decode(bytes);
      } catch {
        return;
      }
    }

    this._cache.set(uri.fsPath, newContent);

    const { hunks, addedLines, removedLines, skippedDiff } = computeDiff(oldContent, newContent);

    if (addedLines === 0 && removedLines === 0 && !skippedDiff) { return; }

    const diffText = rawDiffText(hunks);
    const estimatedTokens = estimateTokens(diffText);
    const costPerMillion = vscode.workspace.getConfiguration('gofi').get<number>('costPerMillionTokens', 3.0);
    const estimatedCostUsd = estimateCost(estimatedTokens, costPerMillion);

    const change: FileChange = {
      id: randomUUID(),
      filePath: uri.fsPath,
      relPath: vscode.workspace.asRelativePath(uri.fsPath),
      changeType,
      timestamp: new Date().toISOString(),
      hunks,
      addedLines,
      removedLines,
      estimatedTokens,
      estimatedCostUsd,
      skippedDiff,
    };

    this._changes.push(change);
    this._onFileChange.fire(change);

    if (vscode.workspace.getConfiguration('gofi').get<boolean>('enableConfidenceScoring')) {
      this._onConfidenceNeeded.fire(change);
    }
  }

  applyConfidence(changeId: string, confidence: FileChange['confidence']): FileChange | undefined {
    const change = this._changes.find(c => c.id === changeId);
    if (change) { change.confidence = confidence; }
    return change;
  }

  enrichWithHookContext(event: HookEvent): void {
    const filePath = event.tool_input.file_path ?? event.tool_input.path;
    if (!filePath) { return; }

    const now = Date.now();
    const recent = [...this._changes]
      .reverse()
      .find(c =>
        (c.filePath === filePath || c.filePath.endsWith('/' + filePath) || filePath.endsWith('/' + c.relPath)) &&
        now - new Date(c.timestamp).getTime() < 3000
      );

    if (recent) {
      recent.hookContext = {
        sessionId: event.session_id ?? '',
        toolName: event.tool_name,
        hookEventName: event.hook_event_name ?? 'PostToolUse',
      };
    }
  }

  dispose(): void {
    this._onFileChange.dispose();
    this._onConfidenceNeeded.dispose();
  }
}
