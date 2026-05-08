import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ExtToWebviewMsg, WebviewToExtMsg } from './types';

export class SessionPanel implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'gofi.sessionPanel';

  private _view?: vscode.WebviewView;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _onReady = new vscode.EventEmitter<void>();
  private readonly _onScorePromptRequest = new vscode.EventEmitter<string>();
  private readonly _onDeleteSession = new vscode.EventEmitter<string>();
  readonly onReady = this._onReady.event;
  readonly onScorePromptRequest = this._onScorePromptRequest.event;
  readonly onDeleteSession = this._onDeleteSession.event;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtMsg) => this._handleWebviewMessage(msg),
      null,
      this._disposables
    );

    webviewView.onDidDispose(() => { this._view = undefined; }, null, this._disposables);
  }

  private _handleWebviewMessage(msg: WebviewToExtMsg): void {
    switch (msg.type) {
      case 'ready':
        this._onReady.fire();
        break;
      case 'openFile':
        vscode.window.showTextDocument(vscode.Uri.file(msg.filePath)).then(
          undefined,
          err => vscode.window.showErrorMessage(`Gofi: Cannot open file — ${err}`)
        );
        break;
      case 'startSession':
        vscode.commands.executeCommand('gofi.startSession');
        break;
      case 'stopSession':
        vscode.commands.executeCommand('gofi.stopSession');
        break;
      case 'clearSession':
        vscode.commands.executeCommand('gofi.clearSession');
        break;
      case 'scorePrompt':
        this._onScorePromptRequest.fire(msg.prompt);
        break;
      case 'copyReview':
        vscode.env.clipboard.writeText(msg.text).then(() => {
          vscode.window.showInformationMessage('Gofi: Review prompt copied — paste into Claude Code.');
        });
        break;
      case 'deleteSession':
        this._onDeleteSession.fire(msg.sessionId);
        break;
    }
  }

  // Called by extension.ts to send messages to the WebView
  send(msg: ExtToWebviewMsg): void {
    this._view?.webview.postMessage(msg);
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js')
    );

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Gofi</title>
  <style nonce="${nonce}">
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);
      font-size:var(--vscode-font-size,12px);
      color:var(--vscode-foreground);
      background:var(--vscode-sideBar-background,var(--vscode-editor-background));
      overflow-x:hidden;
      height:100vh;
      display:flex;
      flex-direction:column;
    }
    /* ── Header ── */
    .header{
      padding:8px;
      border-bottom:1px solid var(--vscode-panel-border);
      background:var(--vscode-sideBarSectionHeader-background);
      flex-shrink:0;
    }
    .stats-grid{
      display:grid;
      grid-template-columns:repeat(3,1fr);
      gap:3px;
      margin-bottom:8px;
    }
    .stat{
      display:flex;
      flex-direction:column;
      padding:3px 5px;
      background:var(--vscode-input-background);
      border-radius:3px;
      min-width:0;
    }
    .stat-label{
      font-size:9px;
      color:var(--vscode-descriptionForeground);
      text-transform:uppercase;
      letter-spacing:.04em;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .stat-value{
      font-weight:600;
      font-size:12px;
      font-variant-numeric:tabular-nums;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    /* ── Controls ── */
    .controls{
      display:flex;
      gap:4px;
      align-items:center;
      flex-wrap:wrap;
    }
    button{
      padding:3px 9px;
      border:1px solid var(--vscode-button-border,transparent);
      border-radius:3px;
      background:var(--vscode-button-secondaryBackground);
      color:var(--vscode-button-secondaryForeground);
      cursor:pointer;
      font-size:11px;
      font-family:inherit;
      white-space:nowrap;
    }
    button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
    button:disabled{opacity:.4;cursor:default}
    button.primary{
      background:var(--vscode-button-background);
      color:var(--vscode-button-foreground);
    }
    button.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
    .provider-badge{
      margin-left:auto;
      font-size:11px;
      font-weight:600;
      padding:3px 8px;
      border-radius:10px;
      background:#1a1a1a;
      color:#e8e8e8;
      white-space:nowrap;
      display:inline-flex;align-items:center;gap:5px;
    }
    .provider-badge svg{width:13px;height:13px;flex-shrink:0}
    /* ── Status bar ── */
    .status-bar{
      display:flex;
      align-items:center;
      gap:6px;
      padding:3px 8px;
      background:var(--vscode-statusBar-background,#007acc);
      color:var(--vscode-statusBar-foreground,#fff);
      font-size:10px;
      flex-shrink:0;
    }
    .dot{width:7px;height:7px;border-radius:50%;background:#777;flex-shrink:0}
    .dot.active{background:#4ec9b0;animation:pulse 2s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    /* ── Feed ── */
    /* ── Current session feed ── */
    .feed-section{flex:1;display:flex;flex-direction:column;min-height:0}
    .feed-hdr{
      display:flex;align-items:center;gap:5px;padding:5px 8px;
      cursor:pointer;user-select:none;font-size:11px;font-weight:600;
      background:var(--vscode-sideBarSectionHeader-background);
      flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border);
    }
    .feed-hdr:hover{background:var(--vscode-list-hoverBackground)}
    .feed-section.open .feed-hdr .expand-icon{transform:rotate(90deg)}
    .feed{display:none;flex:1;overflow-y:auto;overflow-x:hidden}
    .feed-section.open .feed{display:block}
    .feed-count{
      font-size:9px;padding:1px 5px;border-radius:10px;
      background:rgba(88,166,255,.15);color:#79b8ff;font-weight:600;
      transition:background .2s,color .2s;
    }
    @keyframes feed-ping{
      0%  {box-shadow:0 0 0 0 rgba(230,162,60,.8);background:rgba(230,162,60,.35);color:#e6a23c}
      60% {box-shadow:0 0 0 5px rgba(230,162,60,0)}
      100%{box-shadow:0 0 0 0 rgba(230,162,60,0);background:rgba(88,166,255,.15);color:#79b8ff}
    }
    .feed-count.ping{animation:feed-ping .7s ease-out forwards}
    .empty-state{
      padding:32px 16px;
      text-align:center;
      color:var(--vscode-descriptionForeground);
      font-size:11px;
      line-height:1.6;
    }
    /* ── Change entry ── */
    .entry{border-bottom:1px solid var(--vscode-panel-border)}
    .entry-header{
      display:flex;
      align-items:center;
      gap:5px;
      padding:5px 8px;
      cursor:pointer;
      user-select:none;
    }
    .entry-header:hover{background:var(--vscode-list-hoverBackground)}
    .badge{
      padding:1px 4px;
      border-radius:2px;
      font-size:9px;
      font-weight:700;
      letter-spacing:.04em;
      flex-shrink:0;
    }
    .badge.created{background:rgba(40,167,69,.18);color:#4ec9b0}
    .badge.modified{background:rgba(230,162,60,.18);color:#e6a23c}
    .badge.deleted{background:rgba(220,53,69,.18);color:#f48771}
    .entry-path{
      font-family:var(--vscode-editor-font-family,monospace);
      font-size:11px;
      flex:1;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      cursor:pointer;
      text-decoration:underline;
      text-underline-offset:2px;
      text-decoration-color:transparent;
    }
    .entry-path:hover{text-decoration-color:var(--vscode-foreground)}
    .entry-stats{
      display:flex;
      gap:4px;
      font-size:10px;
      flex-shrink:0;
      font-variant-numeric:tabular-nums;
    }
    .s-add{color:#4ec9b0}
    .s-rem{color:#f48771}
    .s-tok{color:var(--vscode-descriptionForeground)}
    .hook-tag{
      font-size:9px;
      padding:1px 4px;
      border-radius:2px;
      background:rgba(88,166,255,.15);
      color:#79b8ff;
      font-weight:600;
      flex-shrink:0;
    }
    .entry-time{
      font-size:9px;
      color:var(--vscode-descriptionForeground);
      flex-shrink:0;
      font-variant-numeric:tabular-nums;
    }
    .expand-icon{
      font-size:10px;
      color:var(--vscode-descriptionForeground);
      flex-shrink:0;
      transition:transform .15s;
      width:12px;
      text-align:center;
    }
    .entry.open .expand-icon{transform:rotate(90deg)}
    /* ── Confidence bar ── */
    .conf-bar{
      display:none;
      align-items:center;
      gap:6px;
      padding:3px 8px 3px 26px;
      background:var(--vscode-input-background);
      border-top:1px solid var(--vscode-panel-border);
      font-size:10px;
      flex-wrap:wrap;
    }
    .entry.open .conf-bar{display:flex}
    .cscore{
      padding:1px 6px;
      border-radius:10px;
      font-weight:600;
      font-size:10px;
    }
    .cscore.hi{background:rgba(78,201,176,.15);color:#4ec9b0}
    .cscore.md{background:rgba(230,162,60,.15);color:#e6a23c}
    .cscore.lo{background:rgba(244,135,113,.15);color:#f48771}
    .ctext{color:var(--vscode-descriptionForeground);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    /* ── Diff view ── */
    .diff-view{
      display:none;
      font-family:var(--vscode-editor-font-family,'Courier New',monospace);
      font-size:var(--vscode-editor-font-size,12px);
      line-height:1.45;
      background:var(--vscode-editor-background);
      border-top:1px solid var(--vscode-panel-border);
      overflow-x:auto;
    }
    .entry.open .diff-view{display:block}
    .hunk-hdr{
      padding:2px 8px;
      background:rgba(88,166,255,.08);
      color:#79b8ff;
      font-size:10px;
      border-top:1px solid rgba(88,166,255,.15);
    }
    .dl{display:flex;padding:0 4px;white-space:pre}
    .dl:hover{background:var(--vscode-list-hoverBackground)!important}
    .ln{
      width:30px;
      text-align:right;
      padding-right:8px;
      color:var(--vscode-editorLineNumber-foreground);
      font-size:10px;
      flex-shrink:0;
      user-select:none;
    }
    .pfx{width:14px;flex-shrink:0;font-weight:600}
    .code{flex:1;overflow:hidden}
    .dl.added{background:rgba(40,167,69,.1)}
    .dl.added .pfx{color:#4ec9b0}
    .dl.removed{background:rgba(220,53,69,.1)}
    .dl.removed .pfx{color:#f48771}
    .dl.context .pfx{color:var(--vscode-descriptionForeground)}
    .diff-skipped{
      padding:8px 12px;
      color:var(--vscode-descriptionForeground);
      font-size:11px;
      font-style:italic;
      text-align:center;
    }
    /* ── Prompt scorer ── */
    .prompt-section{border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .prompt-hdr{
      display:flex;align-items:center;gap:5px;padding:5px 8px;
      cursor:pointer;user-select:none;font-size:11px;font-weight:600;
      background:var(--vscode-sideBarSectionHeader-background);
    }
    .prompt-hdr:hover{background:var(--vscode-list-hoverBackground)}
    .prompt-section.open .prompt-hdr .expand-icon{transform:rotate(90deg)}
    .prompt-body{display:none;padding:6px 8px}
    .prompt-section.open .prompt-body{display:block}
    .prompt-text{
      font-size:11px;padding:4px 6px;min-height:40px;max-height:90px;overflow-y:auto;
      background:var(--vscode-input-background);border-radius:3px;
      white-space:pre-wrap;word-break:break-word;margin-bottom:5px;
    }
    .prompt-text.empty{font-style:italic;color:var(--vscode-descriptionForeground)}
    .scoring-hint{font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;display:block;margin-bottom:4px}
    .review-area{
      display:none;padding:5px 8px;background:var(--vscode-editor-background);
      border-top:1px solid var(--vscode-panel-border);
    }
    .entry.open .review-area{display:block}
    .review-input{
      width:100%;min-height:48px;display:block;margin-bottom:5px;
      background:var(--vscode-input-background);color:var(--vscode-input-foreground);
      border:1px solid var(--vscode-input-border,transparent);
      border-radius:3px;padding:4px 6px;font-family:inherit;font-size:11px;resize:vertical;
    }
    .review-input:focus{outline:1px solid var(--vscode-focusBorder);border-color:transparent}
    .review-actions{display:flex;align-items:center;gap:8px}
    .copy-toast{font-size:10px;color:#4ec9b0;display:none}
    .pr-scores{display:flex;gap:6px;margin-bottom:5px;flex-wrap:wrap}
    .pr-issues{list-style:none;padding:0;margin:0}
    .pr-issues li{font-size:10px;padding:1px 0 1px 14px;position:relative;color:var(--vscode-foreground)}
    .pr-issues li::before{content:'⚠';position:absolute;left:0;font-size:9px;color:#e6a23c}
    /* ── Context reads log ── */
    .reads-section{border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .reads-hdr{
      display:flex;align-items:center;gap:5px;padding:5px 8px;
      cursor:pointer;user-select:none;font-size:11px;font-weight:600;
      background:var(--vscode-sideBarSectionHeader-background);
    }
    .reads-hdr:hover{background:var(--vscode-list-hoverBackground)}
    .reads-section.open .reads-hdr .expand-icon{transform:rotate(90deg)}
    .reads-body{display:none;max-height:160px;overflow-y:auto}
    .reads-section.open .reads-body{display:block}
    .reads-count{
      font-size:9px;padding:1px 5px;border-radius:10px;
      background:rgba(88,166,255,.15);color:#79b8ff;font-weight:600;
    }
    .reads-total{margin-left:auto;font-size:10px;color:var(--vscode-descriptionForeground)}
    .read-entry{
      display:flex;align-items:center;gap:6px;padding:3px 8px;
      border-bottom:1px solid var(--vscode-panel-border);font-size:10px;
    }
    .read-time{color:var(--vscode-descriptionForeground);flex-shrink:0;font-variant-numeric:tabular-nums}
    .read-prompt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      color:var(--vscode-foreground);font-style:italic}
    .read-tokens{color:var(--vscode-descriptionForeground);flex-shrink:0;font-variant-numeric:tabular-nums}
    .read-cost{color:#e6a23c;flex-shrink:0;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
    /* ── Past sessions ── */
    .sessions-section{border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .sessions-hdr{
      display:flex;align-items:center;gap:5px;padding:5px 8px;
      cursor:pointer;user-select:none;font-size:11px;font-weight:600;
      background:var(--vscode-sideBarSectionHeader-background);
    }
    .sessions-hdr:hover{background:var(--vscode-list-hoverBackground)}
    .sessions-section.open .sessions-hdr .expand-icon{transform:rotate(90deg)}
    .sessions-body{display:none;max-height:200px;overflow-y:auto}
    .sessions-section.open .sessions-body{display:block}
    .sessions-count{
      font-size:9px;padding:1px 5px;border-radius:10px;
      background:rgba(230,162,60,.15);color:#e6a23c;font-weight:600;
    }
    .sessions-total{margin-left:auto;font-size:10px;color:var(--vscode-descriptionForeground)}
    .session-row{
      display:flex;align-items:center;gap:5px;padding:4px 8px;
      border-bottom:1px solid var(--vscode-panel-border);font-size:10px;
    }
    .session-row:hover{background:var(--vscode-list-hoverBackground)}
    .session-date{color:var(--vscode-descriptionForeground);flex-shrink:0;min-width:80px;font-variant-numeric:tabular-nums}
    .session-meta{flex:1;color:var(--vscode-foreground);display:flex;gap:6px;flex-wrap:wrap}
    .session-stat{color:var(--vscode-descriptionForeground)}
    .session-cost{color:#e6a23c;flex-shrink:0;font-variant-numeric:tabular-nums}
    .session-del{
      background:none;border:none;cursor:pointer;padding:0 2px;
      color:var(--vscode-descriptionForeground);font-size:12px;line-height:1;
      flex-shrink:0;opacity:.5;
    }
    .session-del:hover{opacity:1;color:#f48771}
    /* ── Sound toggle ── */
    .btn-sound{
      margin-left:auto;background:none;border:none;cursor:pointer;
      padding:2px 4px;line-height:1;opacity:.45;
      color:var(--vscode-foreground);display:flex;align-items:center;
    }
    .btn-sound:hover{opacity:.8}
    .btn-sound.on{opacity:1;color:#4ec9b0}
    .btn-sound svg{width:16px;height:16px;fill:currentColor}
    .hidden{display:none}
  </style>
</head>
<body>
  <div class="header">
    <div class="stats-grid">
      <div class="stat"><span class="stat-label">Files</span><span class="stat-value" id="s-files">0</span></div>
      <div class="stat"><span class="stat-label">+Lines</span><span class="stat-value s-add" id="s-added">0</span></div>
      <div class="stat"><span class="stat-label">−Lines</span><span class="stat-value s-rem" id="s-removed">0</span></div>
      <div class="stat"><span class="stat-label">~Tokens</span><span class="stat-value" id="s-tokens">0</span></div>
      <div class="stat"><span class="stat-label">Cost</span><span class="stat-value" id="s-cost">$0.00</span></div>
      <div class="stat"><span class="stat-label">Duration</span><span class="stat-value" id="s-dur">—</span></div>
    </div>
    <div class="controls">
      <button class="primary" id="btn-start" data-action="start">Start</button>
      <button id="btn-stop" data-action="stop" disabled>Stop</button>
      <button id="btn-clear" data-action="clear">Clear</button>
      <span class="provider-badge" id="provider-badge">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="#D97757">
          <g transform="translate(8,8)">
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(0)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(45)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(90)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(135)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(180)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(225)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(270)"/>
            <rect x="-1" y="-6.5" width="2" height="4.8" rx="1" transform="rotate(315)"/>
          </g>
        </svg>
        Claude
      </span>
      <button class="btn-sound" id="btn-sound" title="Toggle notification sound">
        <svg id="icon-mute" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5a.5.5 0 0 1 .5.5v11.5a.5.5 0 0 1-.854.354L4.293 10.5H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h2.293L7.646 1.854A.5.5 0 0 1 8 1.5zM2 6.5v3h2.5l3 3V3.5l-3 3H2zM13.354 5.146a.5.5 0 0 1 0 .708l-1.5 1.5 1.5 1.5a.5.5 0 0 1-.708.708l-1.5-1.5-1.5 1.5a.5.5 0 0 1-.708-.708l1.5-1.5-1.5-1.5a.5.5 0 0 1 .708-.708l1.5 1.5 1.5-1.5a.5.5 0 0 1 .708 0z"/></svg>
        <svg id="icon-sound" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" class="hidden"><path d="M8 1.5a.5.5 0 0 1 .5.5v11.5a.5.5 0 0 1-.854.354L4.293 10.5H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h2.293L7.646 1.854A.5.5 0 0 1 8 1.5zM2 6.5v3h2.5l3 3V3.5l-3 3H2zM11.536 4.5a.5.5 0 0 1 .707.017A4.49 4.49 0 0 1 13.5 7.75a4.49 4.49 0 0 1-1.257 3.233.5.5 0 0 1-.724-.69A3.49 3.49 0 0 0 12.5 7.75a3.49 3.49 0 0 0-.98-2.493.5.5 0 0 1 .016-.757zM10.121 6.121a.5.5 0 0 1 .707.014 2.49 2.49 0 0 1 0 3.23.5.5 0 0 1-.721-.693 1.49 1.49 0 0 0 0-1.844.5.5 0 0 1 .014-.707z"/></svg>
      </button>
    </div>
  </div>
  <div class="status-bar">
    <span class="dot" id="status-dot"></span>
    <span id="status-text">Loading…</span>
  </div>
  <div class="prompt-section open" id="prompt-section">
    <div class="prompt-hdr">
      <span class="expand-icon">›</span>
      <span>Latest Prompt</span>
    </div>
    <div class="prompt-body">
      <div id="prompt-text" class="prompt-text empty">Waiting for prompt…</div>
      <span class="scoring-hint" id="scoring-hint" style="display:none">Analyzing…</span>
      <div id="prompt-result" style="display:none">
        <div class="pr-scores">
          <span class="cscore" id="pr-clarity"></span>
          <span class="cscore" id="pr-completeness"></span>
        </div>
        <ul class="pr-issues" id="pr-issues"></ul>
      </div>
    </div>
  </div>
  <div class="reads-section" id="reads-section" style="display:none">
    <div class="reads-hdr">
      <span class="expand-icon">›</span>
      <span>Context Reads</span>
      <span class="reads-count" id="reads-count">0</span>
      <span class="reads-total" id="reads-total">$0.00</span>
    </div>
    <div class="reads-body" id="reads-body"></div>
  </div>
  <div class="sessions-section" id="sessions-section" style="display:none">
    <div class="sessions-hdr">
      <span class="expand-icon">›</span>
      <span>Past Sessions</span>
      <span class="sessions-count" id="sessions-count">0</span>
      <span class="sessions-total" id="sessions-total">$0.00</span>
    </div>
    <div class="sessions-body" id="sessions-body"></div>
  </div>
  <div class="feed-section open" id="feed-section">
    <div class="feed-hdr">
      <span class="expand-icon">›</span>
      <span>Current Session</span>
      <span class="feed-count" id="feed-count">0</span>
    </div>
    <div class="feed" id="feed">
      <div class="empty-state">No file changes detected yet.<br>Start a monitoring session, then run Claude Code.</div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }
}
