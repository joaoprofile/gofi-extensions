import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiffTracker } from './DiffTracker';
import { FSWatcher } from './FSWatcher';
import { HookWatcher } from './HookWatcher';
import { PromptWatcher } from './PromptWatcher';
import { ClaudeConfidenceProvider, NoOpProvider } from './ConfidenceService';
import { ContextReadTracker } from './ContextReadTracker';
import { SessionPanel } from './SessionPanel';
import { AIProvider, ContextReadEntry, FileChange, SavedSession } from './types';

let statsTimer: ReturnType<typeof setInterval> | undefined;

// ── Persistence helpers ───────────────────────────────────────────────────────

interface LiveSessionState {
  changes: FileChange[];
  contextReads: ContextReadEntry[];
}

function saveLiveSession(
  context: vscode.ExtensionContext,
  diffTracker: DiffTracker,
  contextReadTracker: ContextReadTracker
): void {
  context.workspaceState.update('gofi.liveSession', {
    changes: diffTracker.changes,
    contextReads: contextReadTracker.entries,
  } satisfies LiveSessionState);
}

function getSavedSessions(context: vscode.ExtensionContext): SavedSession[] {
  return context.workspaceState.get<SavedSession[]>('gofi.sessionHistory') ?? [];
}

function archiveSession(
  context: vscode.ExtensionContext,
  diffTracker: DiffTracker,
  contextReadTracker: ContextReadTracker
): SavedSession | null {
  const stats = diffTracker.stats;
  if (stats.fileChangeCount === 0 && contextReadTracker.entries.length === 0) { return null; }

  const readsCost = contextReadTracker.entries.reduce((s, e) => s + e.estimatedCostUsd, 0);
  const readsTokens = contextReadTracker.entries.reduce((s, e) => s + e.estimatedTokens, 0);

  const session: SavedSession = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    savedAt: new Date().toISOString(),
    changes: diffTracker.changes,
    contextReads: contextReadTracker.entries,
    stats: {
      ...stats,
      totalEstimatedCostUsd: stats.totalEstimatedCostUsd + readsCost,
      totalEstimatedTokens: stats.totalEstimatedTokens + readsTokens,
    },
  };

  const history = getSavedSessions(context);
  history.unshift(session);
  context.workspaceState.update('gofi.sessionHistory', history.slice(0, 10));
  return session;
}

export function activate(context: vscode.ExtensionContext): void {
  const diffTracker = new DiffTracker();
  const contextReadTracker = new ContextReadTracker();

  // Restore live session state from previous window
  try {
    const savedLive = context.workspaceState.get<LiveSessionState>('gofi.liveSession');
    if (savedLive) {
      diffTracker.restore(savedLive.changes);
      contextReadTracker.restore(savedLive.contextReads ?? []);
    }
  } catch {
    // Bad data in workspaceState — clear it and start fresh rather than crashing activate()
    context.workspaceState.update('gofi.liveSession', undefined);
  }

  const fsWatcher = new FSWatcher(diffTracker);
  const hookWatcher = new HookWatcher();
  const promptWatcher = new PromptWatcher();
  const sessionPanel = new SessionPanel(context.extensionUri);

  const provider: AIProvider = vscode.workspace.getConfiguration('gofi')
    .get<string>('aiProvider', 'claude') === 'claude'
    ? new ClaudeConfidenceProvider()
    : new NoOpProvider();

  // ── Handle webview 'ready' by sending full init ───────────────────────────
  // Must be subscribed BEFORE registerWebviewViewProvider to avoid race when
  // the view is already visible at activation time.
  context.subscriptions.push(
    sessionPanel.onReady(() => {
      sessionPanel.send({
        type: 'init',
        stats: diffTracker.stats,
        changes: diffTracker.changes,
        contextReads: contextReadTracker.entries,
        savedSessions: getSavedSessions(context),
      });
    })
  );

  // ── Register WebView ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionPanel.VIEW_ID,
      sessionPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── File change → WebView + persist ──────────────────────────────────────
  context.subscriptions.push(
    diffTracker.onFileChange(change => {
      contextReadTracker.onFileChange();
      sessionPanel.send({ type: 'fileChangeAdded', change });
      sessionPanel.send({ type: 'statsUpdate', stats: diffTracker.stats });
      saveLiveSession(context, diffTracker, contextReadTracker);
    })
  );

  // ── Confidence scoring (post-change) ─────────────────────────────────────
  context.subscriptions.push(
    diffTracker.onConfidenceNeeded(change => {
      if (provider instanceof ClaudeConfidenceProvider) {
        provider.scheduleScore(change, (changeId, confidence) => {
          diffTracker.applyConfidence(changeId, confidence);
          sessionPanel.send({ type: 'confidenceUpdate', changeId, confidence });
        });
      }
    })
  );

  // ── Prompt scoring (manual via sidebar) ──────────────────────────────────
  context.subscriptions.push(
    sessionPanel.onScorePromptRequest(async prompt => {
      sessionPanel.send({ type: 'promptScoring' });
      const score = await provider.scorePrompt(prompt);
      sessionPanel.send({ type: 'promptScoreResult', score });
    })
  );

  // ── Auto prompt capture from Claude Code session files ────────────────────
  let promptScoreGen = 0;
  let promptScoreTimer: ReturnType<typeof setTimeout> | undefined;

  context.subscriptions.push(
    promptWatcher.onPrompt((detection) => {
      contextReadTracker.onPromptDetected(detection);
      sessionPanel.send({ type: 'promptDetected', prompt: detection.prompt });

      if (!provider.isConfigured() ||
          !vscode.workspace.getConfiguration('gofi').get<boolean>('enableConfidenceScoring')) {
        return;
      }

      // Debounce: if more prompts arrive within 800 ms (e.g. tool results), only score the last one
      if (promptScoreTimer) { clearTimeout(promptScoreTimer); }
      const gen = ++promptScoreGen;
      promptScoreTimer = setTimeout(async () => {
        sessionPanel.send({ type: 'promptScoring' });
        const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000));
        const score = await Promise.race([
          provider.scorePrompt(detection.context || detection.prompt),
          timeout,
        ]);
        // Always clear the indicator; if superseded, send null so the spinner doesn't hang
        if (gen === promptScoreGen) {
          sessionPanel.send({ type: 'promptScoreResult', score });
        } else {
          sessionPanel.send({ type: 'promptScoreResult', score: null });
        }
      }, 800);
    })
  );

  // ── Context-read entries → WebView + persist ─────────────────────────────
  context.subscriptions.push(
    contextReadTracker.onEntry(entry => {
      sessionPanel.send({ type: 'contextReadAdded', entry });
      saveLiveSession(context, diffTracker, contextReadTracker);
    })
  );

  // ── Hook events → DiffTracker enrichment ─────────────────────────────────
  context.subscriptions.push(
    hookWatcher.onEvent(event => {
      diffTracker.enrichWithHookContext(event);
    })
  );

  // ── Stats timer (updates duration every second while running) ────────────
  statsTimer = setInterval(() => {
    if (diffTracker.isRunning) {
      sessionPanel.send({ type: 'statsUpdate', stats: diffTracker.stats });
    }
  }, 1000);

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('gofi.startSession', () => {
      diffTracker.startSession();
      sessionPanel.send({ type: 'sessionStarted' });
      sessionPanel.send({ type: 'statsUpdate', stats: diffTracker.stats });
    }),

    vscode.commands.registerCommand('gofi.stopSession', () => {
      diffTracker.stopSession();
      sessionPanel.send({ type: 'sessionStopped' });
      sessionPanel.send({ type: 'statsUpdate', stats: diffTracker.stats });
    }),

    vscode.commands.registerCommand('gofi.clearSession', () => {
      const archived = archiveSession(context, diffTracker, contextReadTracker);
      diffTracker.clearSession();
      contextReadTracker.clearEntries();
      saveLiveSession(context, diffTracker, contextReadTracker);
      sessionPanel.send({ type: 'sessionCleared' });
      sessionPanel.send({ type: 'contextReadsCleared' });
      if (archived) {
        sessionPanel.send({ type: 'sessionArchived', session: archived });
      }
    }),

    vscode.commands.registerCommand('gofi.installHook', () => {
      installClaudeHook(context);
    }),

    vscode.commands.registerCommand('gofi.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key (leave blank to use your Claude Code account)',
        password: true,
        placeHolder: 'sk-ant-... (optional)',
      });
      if (key !== undefined) {
        await vscode.workspace.getConfiguration('gofi')
          .update('anthropicApiKey', key, vscode.ConfigurationTarget.Global);
        if (key.length > 0) {
          await vscode.workspace.getConfiguration('gofi')
            .update('enableConfidenceScoring', true, vscode.ConfigurationTarget.Global);
        }
        vscode.window.showInformationMessage(
          key.length > 0
            ? 'Gofi: API key saved. Confidence scoring enabled.'
            : 'Gofi: API key cleared. Confidence scoring will use your Claude Code account.'
        );
      }
    })
  );

  // ── Delete past session ───────────────────────────────────────────────────
  context.subscriptions.push(
    sessionPanel.onDeleteSession(sessionId => {
      const sessions = getSavedSessions(context);
      context.workspaceState.update('gofi.sessionHistory', sessions.filter(s => s.id !== sessionId));
      sessionPanel.send({ type: 'sessionDeleted', sessionId });
    })
  );

  // ── Start watchers ────────────────────────────────────────────────────────
  fsWatcher.start();
  hookWatcher.start();
  promptWatcher.start();

  context.subscriptions.push(diffTracker, fsWatcher, hookWatcher, promptWatcher, sessionPanel, contextReadTracker);

  if (diffTracker.isRunning) {
    vscode.window.setStatusBarMessage('$(eye) Gofi monitoring', 3000);
  }
}

export function deactivate(): void {
  if (statsTimer !== undefined) {
    clearInterval(statsTimer);
  }
}

// ── Hook installer ────────────────────────────────────────────────────────────

async function installClaudeHook(context: vscode.ExtensionContext): Promise<void> {
  const hookScriptSrc = path.join(context.extensionPath, 'scripts', 'gofi-hook.js');
  const claudeDir = path.join(os.homedir(), '.claude');
  const hookScriptDst = path.join(claudeDir, 'gofi-hook.js');
  const settingsPath = path.join(claudeDir, 'settings.json');

  try {
    // Copy hook script
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.copyFileSync(hookScriptSrc, hookScriptDst);

    // Read / create settings.json
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        const answer = await vscode.window.showWarningMessage(
          'Gofi: ~/.claude/settings.json exists but could not be parsed. Overwrite?',
          'Overwrite', 'Cancel'
        );
        if (answer !== 'Overwrite') { return; }
      }
    }

    // Deep-merge the hook entry
    if (!settings.hooks) { settings.hooks = {}; }
    const hooks = settings.hooks as Record<string, unknown[]>;
    if (!hooks.PostToolUse) { hooks.PostToolUse = []; }

    const hookEntry = {
      matcher: 'Write|Edit|MultiEdit',
      hooks: [{ type: 'command', command: `node "${hookScriptDst}"` }],
    };

    // Avoid duplicate entries
    const existing = hooks.PostToolUse as Array<{ matcher?: string }>;
    const idx = existing.findIndex(e => e.matcher === hookEntry.matcher);
    if (idx >= 0) {
      existing[idx] = hookEntry;
    } else {
      existing.push(hookEntry);
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const logPath = path.join(claudeDir, 'gofi-events.jsonl');
    vscode.window.showInformationMessage(
      `Gofi: Hook installed. Events will log to ${logPath}`,
      'Open settings.json'
    ).then(action => {
      if (action === 'Open settings.json') {
        vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Gofi: Failed to install hook — ${err}`);
  }
}
