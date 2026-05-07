// ─── Diff primitives ────────────────────────────────────────────────────────

export type DiffLineType = 'added' | 'removed' | 'context';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNoOld: number | null;
  lineNoNew: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
}

// ─── File change ─────────────────────────────────────────────────────────────

export type ChangeType = 'created' | 'modified' | 'deleted';

export interface FileChange {
  id: string;
  filePath: string;
  relPath: string;
  changeType: ChangeType;
  timestamp: string;       // ISO string (JSON-serializable for WebView state)
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  confidence?: ConfidenceResult;
  hookContext?: HookEventContext;
  skippedDiff: boolean;
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

export interface ConfidenceResult {
  correctness: number;
  quality: number;
  rationale: string;
  modelUsed: string;
  latencyMs: number;
}

export interface PromptScore {
  clarity: number;
  completeness: number;
  issues: string[];
}

// ─── Session stats ────────────────────────────────────────────────────────────

export interface SessionStats {
  isRunning: boolean;
  startTime: string | null;     // ISO string or null
  durationMs: number;
  fileChangeCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  totalEstimatedTokens: number;
  totalEstimatedCostUsd: number;
  uniqueFilesChanged: number;
}

// ─── AI provider abstraction ──────────────────────────────────────────────────

export interface AIProvider {
  readonly name: string;
  scoreChange(change: FileChange): Promise<ConfidenceResult | null>;
  scorePrompt(prompt: string): Promise<PromptScore | null>;
  isConfigured(): boolean;
}

// ─── Hook events ─────────────────────────────────────────────────────────────

export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  tool_name: string;
  tool_input: {
    file_path?: string;
    path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    edits?: Array<{ old_string: string; new_string: string }>;
    [key: string]: unknown;
  };
  tool_response?: unknown;
  timestamp?: string;
}

export interface HookEventContext {
  sessionId: string;
  toolName: string;
  hookEventName: string;
}

// ─── WebView message types ────────────────────────────────────────────────────

export type ExtToWebviewMsg =
  | { type: 'init'; stats: SessionStats; changes: FileChange[] }
  | { type: 'statsUpdate'; stats: SessionStats }
  | { type: 'fileChangeAdded'; change: FileChange }
  | { type: 'confidenceUpdate'; changeId: string; confidence: ConfidenceResult }
  | { type: 'sessionCleared' }
  | { type: 'sessionStarted' }
  | { type: 'sessionStopped' }
  | { type: 'promptScoring' }
  | { type: 'promptScoreResult'; score: PromptScore | null }
  | { type: 'promptDetected'; prompt: string };

export type WebviewToExtMsg =
  | { type: 'ready' }
  | { type: 'startSession' }
  | { type: 'stopSession' }
  | { type: 'clearSession' }
  | { type: 'openFile'; filePath: string }
  | { type: 'scorePrompt'; prompt: string };
