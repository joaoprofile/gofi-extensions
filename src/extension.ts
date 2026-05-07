import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiffTracker } from './DiffTracker';
import { FSWatcher } from './FSWatcher';
import { HookWatcher } from './HookWatcher';
import { PromptWatcher } from './PromptWatcher';
import { ClaudeConfidenceProvider, NoOpProvider } from './ConfidenceService';
import { SessionPanel } from './SessionPanel';
import { AIProvider } from './types';

let statsTimer: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const diffTracker = new DiffTracker();
  const fsWatcher = new FSWatcher(diffTracker);
  const hookWatcher = new HookWatcher();
  const promptWatcher = new PromptWatcher();
  const sessionPanel = new SessionPanel(context.extensionUri);

  const provider: AIProvider = vscode.workspace.getConfiguration('gofi')
    .get<string>('aiProvider', 'claude') === 'claude'
    ? new ClaudeConfidenceProvider()
    : new NoOpProvider();

  // ── Register WebView ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionPanel.VIEW_ID,
      sessionPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Handle webview 'ready' by sending full init ───────────────────────────
  context.subscriptions.push(
    sessionPanel.onReady(() => {
      sessionPanel.send({ type: 'init', stats: diffTracker.stats, changes: diffTracker.changes });
    })
  );

  // ── File change → WebView ─────────────────────────────────────────────────
  context.subscriptions.push(
    diffTracker.onFileChange(change => {
      // Refresh stats (may have changed due to hook enrichment race)
      sessionPanel.send({ type: 'fileChangeAdded', change });
      sessionPanel.send({ type: 'statsUpdate', stats: diffTracker.stats });
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
  context.subscriptions.push(
    promptWatcher.onPrompt(async prompt => {
      // Populate the sidebar textarea and open the section immediately
      sessionPanel.send({ type: 'promptDetected', prompt });
      // Auto-score if configured
      if (provider.isConfigured() &&
          vscode.workspace.getConfiguration('gofi').get<boolean>('enableConfidenceScoring')) {
        sessionPanel.send({ type: 'promptScoring' });
        const score = await provider.scorePrompt(prompt);
        sessionPanel.send({ type: 'promptScoreResult', score });
      }
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
      diffTracker.clearSession();
      sessionPanel.send({ type: 'sessionCleared' });
    }),

    vscode.commands.registerCommand('gofi.installHook', () => {
      installClaudeHook(context);
    }),

    vscode.commands.registerCommand('gofi.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key',
        password: true,
        placeHolder: 'sk-ant-...',
      });
      if (key !== undefined) {
        await vscode.workspace.getConfiguration('gofi')
          .update('anthropicApiKey', key, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('gofi')
          .update('enableConfidenceScoring', key.length > 0, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          key.length > 0
            ? 'Gofi: API key saved. Confidence scoring enabled.'
            : 'Gofi: API key cleared. Confidence scoring disabled.'
        );
      }
    })
  );

  // ── Start watchers ────────────────────────────────────────────────────────
  fsWatcher.start();
  hookWatcher.start();
  promptWatcher.start();

  context.subscriptions.push(diffTracker, fsWatcher, hookWatcher, promptWatcher, sessionPanel);

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
