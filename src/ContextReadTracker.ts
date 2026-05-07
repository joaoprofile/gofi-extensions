import * as fs from 'fs';
import * as vscode from 'vscode';
import { ContextReadEntry, PromptDetection } from './types';
import { estimateCost } from './TokenEstimator';

/**
 * Detects Claude Code sessions where a prompt was submitted but no file writes
 * followed within the debounce window — i.e. pure context reads / Q&A.
 *
 * When such a session is detected, reads the JSONL delta (everything appended
 * since the prompt was written) to estimate the total tokens consumed: user
 * prompt, files Claude read (tool_result content), and assistant responses.
 */
export class ContextReadTracker implements vscode.Disposable {
  private readonly _onEntry = new vscode.EventEmitter<ContextReadEntry>();
  readonly onEntry = this._onEntry.event;

  private _pending: { detection: PromptDetection; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly _entries: ContextReadEntry[] = [];

  get entries(): ContextReadEntry[] { return [...this._entries]; }

  restore(entries: ContextReadEntry[]): void {
    this._entries.push(...entries);
  }

  clearEntries(): void {
    this._entries.length = 0;
    if (this._pending) {
      clearTimeout(this._pending.timer);
      this._pending = null;
    }
  }

  onPromptDetected(detection: PromptDetection): void {
    // Reset the timer on every new prompt — only the latest unanswered-by-writes counts.
    if (this._pending) { clearTimeout(this._pending.timer); }

    const debounceMs = vscode.workspace.getConfiguration('gofi')
      .get<number>('contextReadDebounceMs', 60_000);

    const timer = setTimeout(() => {
      this._pending = null;
      this._emit(detection);
    }, debounceMs);

    this._pending = { detection, timer };
  }

  /** Call whenever a file change is detected — cancels any pending context-read. */
  onFileChange(): void {
    if (this._pending) {
      clearTimeout(this._pending.timer);
      this._pending = null;
    }
  }

  private _emit(detection: PromptDetection): void {
    const tokens = this._estimateTokensDelta(detection);
    const costPerMillion = vscode.workspace.getConfiguration('gofi')
      .get<number>('costPerMillionTokens', 3);

    const entry: ContextReadEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      prompt: detection.prompt.slice(0, 100),
      estimatedTokens: tokens,
      estimatedCostUsd: estimateCost(tokens, costPerMillion),
    };
    this._entries.push(entry);
    this._onEntry.fire(entry);
  }

  /**
   * Reads every JSONL line appended after `detection.fileOffset` and sums the
   * real token counts from the API usage field on assistant messages.
   *
   * Each API call produces several JSONL entries with the same `message.id`
   * (streaming chunks), so we deduplicate by ID and only count each message once.
   *
   * Usage fields summed: input_tokens + cache_creation_input_tokens +
   * cache_read_input_tokens + output_tokens.
   *
   * Falls back to chars/4 if no usage data is found (e.g. empty delta).
   */
  private _estimateTokensDelta(detection: PromptDetection): number {
    try {
      const stat = fs.statSync(detection.filePath, { throwIfNoEntry: false });
      if (!stat || stat.size <= detection.fileOffset) {
        return Math.ceil(detection.context.length / 4);
      }

      const fd = fs.openSync(detection.filePath, 'r');
      const buf = Buffer.alloc(stat.size - detection.fileOffset);
      fs.readSync(fd, buf, 0, buf.length, detection.fileOffset);
      fs.closeSync(fd);

      let totalTokens = 0;
      const seenIds = new Set<string>();

      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const entry = JSON.parse(line);
          const msgId = entry.message?.id as string | undefined;
          const usage = entry.message?.usage as Record<string, number> | undefined;
          if (!usage || !msgId || seenIds.has(msgId)) { continue; }
          seenIds.add(msgId);
          totalTokens +=
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.output_tokens ?? 0);
        } catch { /* skip malformed lines */ }
      }

      return totalTokens > 0 ? totalTokens : Math.ceil(detection.context.length / 4);
    } catch {
      return Math.ceil(detection.context.length / 4);
    }
  }

  dispose(): void {
    if (this._pending) { clearTimeout(this._pending.timer); }
    this._pending = null;
    this._onEntry.dispose();
  }
}
