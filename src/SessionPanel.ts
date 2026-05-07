import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ExtToWebviewMsg, FileChange, SessionStats, WebviewToExtMsg } from './types';

export class SessionPanel implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'gofi.sessionPanel';

  private _view?: vscode.WebviewView;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _onReady = new vscode.EventEmitter<void>();
  private readonly _onScorePromptRequest = new vscode.EventEmitter<string>();
  readonly onReady = this._onReady.event;
  readonly onScorePromptRequest = this._onScorePromptRequest.event;

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
    }
  }

  // Called by extension.ts to send messages to the WebView
  send(msg: ExtToWebviewMsg): void {
    this._view?.webview.postMessage(msg);
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
      font-size:9px;
      padding:2px 6px;
      border-radius:10px;
      background:var(--vscode-badge-background);
      color:var(--vscode-badge-foreground);
      white-space:nowrap;
    }
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
    .feed{
      flex:1;
      overflow-y:auto;
      overflow-x:hidden;
    }
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
    textarea{
      width:100%;min-height:72px;display:block;margin-bottom:5px;
      background:var(--vscode-input-background);color:var(--vscode-input-foreground);
      border:1px solid var(--vscode-input-border,transparent);
      border-radius:3px;padding:4px 6px;font-family:inherit;font-size:11px;resize:vertical;
    }
    textarea:focus{outline:1px solid var(--vscode-focusBorder);border-color:transparent}
    .prompt-actions{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .scoring-hint{font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic}
    .pr-scores{display:flex;gap:6px;margin-bottom:5px;flex-wrap:wrap}
    .pr-issues{list-style:none;padding:0;margin:0}
    .pr-issues li{font-size:10px;padding:1px 0 1px 14px;position:relative;color:var(--vscode-foreground)}
    .pr-issues li::before{content:'⚠';position:absolute;left:0;font-size:9px;color:#e6a23c}
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
      <span class="provider-badge" id="provider-badge">Claude</span>
    </div>
  </div>
  <div class="status-bar">
    <span class="dot" id="status-dot"></span>
    <span id="status-text">Loading…</span>
  </div>
  <div class="prompt-section" id="prompt-section">
    <div class="prompt-hdr">
      <span class="expand-icon">›</span>
      <span>Analyze Prompt</span>
      <span id="auto-badge" style="display:none;margin-left:6px;font-size:9px;padding:1px 5px;border-radius:10px;background:rgba(78,201,176,.15);color:#4ec9b0;font-weight:600">auto</span>
    </div>
    <div class="prompt-body">
      <textarea id="prompt-input" placeholder="Paste your plan or prompt here…"></textarea>
      <div class="prompt-actions">
        <button class="primary" id="btn-score-prompt">Score Prompt</button>
        <span class="scoring-hint" id="scoring-hint" style="display:none">Analyzing…</span>
      </div>
      <div id="prompt-result" style="display:none">
        <div class="pr-scores">
          <span class="cscore" id="pr-clarity"></span>
          <span class="cscore" id="pr-completeness"></span>
        </div>
        <ul class="pr-issues" id="pr-issues"></ul>
      </div>
    </div>
  </div>
  <div class="feed" id="feed">
    <div class="empty-state">No file changes detected yet.<br>Start a monitoring session, then run Claude Code.</div>
  </div>

  <script nonce="${nonce}">(function(){
    const vscode = acquireVsCodeApi();
    let appState = vscode.getState() || {changes:[], stats:null};

    // ── Helpers ──────────────────────────────────────────────────────────────

    function esc(s){
      return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
    }

    function fmtNum(n){
      if(n>=1e6) return (n/1e6).toFixed(1)+'M';
      if(n>=1e3) return (n/1e3).toFixed(1)+'k';
      return String(n);
    }

    function fmtCost(usd){
      if(usd<1e-6) return '$0.00';
      if(usd<1e-4) return '$'+usd.toFixed(6);
      if(usd<0.01) return '$'+usd.toFixed(4);
      return '$'+usd.toFixed(2);
    }

    function fmtDur(ms){
      if(!ms) return '—';
      const s=Math.floor(ms/1000);
      const m=Math.floor(s/60);
      const h=Math.floor(m/60);
      if(h>0) return h+':'+String(m%60).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
      return m+':'+String(s%60).padStart(2,'0');
    }

    function fmtTime(iso){
      const d=new Date(iso);
      return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    }

    function scoreClass(n){return n>=80?'hi':n>=60?'md':'lo'}

    // ── Render stats ─────────────────────────────────────────────────────────

    function renderStats(stats){
      if(!stats) return;
      document.getElementById('s-files').textContent = stats.uniqueFilesChanged;
      document.getElementById('s-added').textContent = '+'+stats.totalAddedLines;
      document.getElementById('s-removed').textContent = '−'+stats.totalRemovedLines;
      document.getElementById('s-tokens').textContent = fmtNum(stats.totalEstimatedTokens);
      document.getElementById('s-cost').textContent = fmtCost(stats.totalEstimatedCostUsd);
      document.getElementById('s-dur').textContent = fmtDur(stats.durationMs);

      const dot = document.getElementById('status-dot');
      const txt = document.getElementById('status-text');
      const start = document.getElementById('btn-start');
      const stop  = document.getElementById('btn-stop');

      if(stats.isRunning){
        dot.className='dot active';
        txt.textContent='Monitoring…';
        start.disabled=true;
        stop.disabled=false;
      } else {
        dot.className='dot';
        txt.textContent=stats.startTime?'Session paused':'Not monitoring';
        start.disabled=false;
        stop.disabled=true;
      }
    }

    // ── Build diff HTML ──────────────────────────────────────────────────────

    function buildDiffHtml(change){
      if(change.skippedDiff){
        return '<div class="diff-skipped">File too large to diff — '+
          change.addedLines+' new / '+change.removedLines+' old lines</div>';
      }
      if(!change.hunks||change.hunks.length===0){
        return '<div class="diff-skipped">No visible changes in this file</div>';
      }
      return change.hunks.map(hunk=>{
        const lns = hunk.lines.map(l=>{
          const pfx = l.type==='added'?'+':l.type==='removed'?'-':' ';
          const ln  = l.lineNoNew??l.lineNoOld??'';
          return '<div class="dl '+esc(l.type)+'">'+
            '<span class="ln">'+ln+'</span>'+
            '<span class="pfx">'+pfx+'</span>'+
            '<span class="code">'+esc(l.content)+'</span>'+
            '</div>';
        }).join('');
        return '<div class="hunk-hdr">'+esc(hunk.header)+'</div>'+lns;
      }).join('');
    }

    // ── Build confidence HTML ────────────────────────────────────────────────

    function buildConfHtml(conf){
      if(!conf) return '<span class="ctext">Awaiting analysis…</span>';
      return '<span class="cscore '+scoreClass(conf.correctness)+'">✓ '+conf.correctness+'%</span>'+
        '<span class="cscore '+scoreClass(conf.quality)+'">★ '+conf.quality+'%</span>'+
        '<span class="ctext">'+esc(conf.rationale)+'</span>';
    }

    // ── Build entry element ───────────────────────────────────────────────────

    function buildEntry(change){
      const div=document.createElement('div');
      div.className='entry';
      div.id='entry-'+change.id;

      const hookTag = change.hookContext
        ? '<span class="hook-tag">'+esc(change.hookContext.toolName)+'</span>'
        : '';

      const confSection = '<div class="conf-bar" id="conf-'+change.id+'">'+buildConfHtml(change.confidence||null)+'</div>';

      div.innerHTML=
        '<div class="entry-header">'+
          '<span class="badge '+esc(change.changeType)+'">'+change.changeType.slice(0,3).toUpperCase()+'</span>'+
          '<span class="entry-path" data-open-file="'+esc(change.filePath)+'" title="'+esc(change.filePath)+'">'+esc(change.relPath)+'</span>'+
          '<span class="entry-stats">'+
            '<span class="s-add">+'+change.addedLines+'</span>'+
            '<span class="s-rem">−'+change.removedLines+'</span>'+
            '<span class="s-tok">~'+fmtNum(change.estimatedTokens)+'t</span>'+
          '</span>'+
          hookTag+
          '<span class="entry-time">'+fmtTime(change.timestamp)+'</span>'+
          '<span class="expand-icon">›</span>'+
        '</div>'+
        confSection+
        '<div class="diff-view" id="diff-'+change.id+'">'+buildDiffHtml(change)+'</div>';

      return div;
    }

    // ── Render full feed ──────────────────────────────────────────────────────

    function renderFeed(changes){
      const feed=document.getElementById('feed');
      feed.innerHTML='';
      if(!changes||changes.length===0){
        feed.innerHTML='<div class="empty-state">No file changes detected yet.<br>Start a monitoring session, then run Claude Code.</div>';
        return;
      }
      // Newest first
      [...changes].reverse().forEach(c=>feed.appendChild(buildEntry(c)));
    }

    // ── Append single new change ──────────────────────────────────────────────

    function appendChange(change){
      const feed=document.getElementById('feed');
      const empty=feed.querySelector('.empty-state');
      if(empty) empty.remove();
      feed.insertBefore(buildEntry(change), feed.firstChild);
      appState.changes.push(change);
      saveState();
    }

    // ── Toggle expand ─────────────────────────────────────────────────────────

    function toggleEntry(entry){
      const isOpen = entry.classList.contains('open');
      // Close all others for cleanliness (optional — comment out to allow multiple open)
      // document.querySelectorAll('.entry.open').forEach(e=>e.classList.remove('open'));
      entry.classList.toggle('open', !isOpen);
    }

    // ── Prompt score ──────────────────────────────────────────────────────────

    function renderPromptScore(score){
      const result=document.getElementById('prompt-result');
      if(!score){
        result.innerHTML='<span class="scoring-hint">Unavailable — configure an API key via <em>Gofi: Set Anthropic API Key</em>.</span>';
        result.style.display='block';
        return;
      }
      const clar=document.getElementById('pr-clarity');
      clar.className='cscore '+scoreClass(score.clarity);
      clar.textContent='Clarity '+score.clarity+'%';
      const comp=document.getElementById('pr-completeness');
      comp.className='cscore '+scoreClass(score.completeness);
      comp.textContent='Completeness '+score.completeness+'%';
      document.getElementById('pr-issues').innerHTML=score.issues.length
        ?score.issues.map(i=>'<li>'+esc(i)+'</li>').join('')
        :'<li style="color:var(--vscode-descriptionForeground)">No issues detected</li>';
      result.style.display='block';
    }

    // ── Update confidence ─────────────────────────────────────────────────────

    function updateConfidence(changeId, conf){
      const bar=document.getElementById('conf-'+changeId);
      if(bar) bar.innerHTML=buildConfHtml(conf);
      const c=appState.changes.find(x=>x.id===changeId);
      if(c){ c.confidence=conf; saveState(); }
    }

    // ── State persistence ─────────────────────────────────────────────────────

    function saveState(){
      // Keep only last 200 changes in persisted state to avoid memory bloat
      vscode.setState({
        changes: appState.changes.slice(-200),
        stats: appState.stats
      });
    }

    // ── Event delegation ──────────────────────────────────────────────────────

    document.addEventListener('click', function(e){
      const fileEl = e.target.closest('[data-open-file]');
      if(fileEl){
        const header = fileEl.closest('.entry-header');
        // If clicking the path span, open file; don't also toggle
        if(fileEl.classList.contains('entry-path')){
          e.stopPropagation();
          vscode.postMessage({type:'openFile', filePath:fileEl.dataset.openFile});
          return;
        }
      }

      const header = e.target.closest('.entry-header');
      if(header){
        toggleEntry(header.closest('.entry'));
        return;
      }

      const promptHdr=e.target.closest('.prompt-hdr');
      if(promptHdr){
        document.getElementById('prompt-section').classList.toggle('open');
        return;
      }

      if(e.target.id==='btn-score-prompt'){
        const prompt=document.getElementById('prompt-input').value.trim();
        if(!prompt) return;
        document.getElementById('btn-score-prompt').disabled=true;
        document.getElementById('scoring-hint').style.display='inline';
        document.getElementById('prompt-result').style.display='none';
        vscode.postMessage({type:'scorePrompt',prompt});
        return;
      }

      const btn = e.target.closest('[data-action]');
      if(btn){
        const action=btn.dataset.action;
        if(action==='start') vscode.postMessage({type:'startSession'});
        else if(action==='stop') vscode.postMessage({type:'stopSession'});
        else if(action==='clear') vscode.postMessage({type:'clearSession'});
      }
    });

    // ── Message handler ───────────────────────────────────────────────────────

    window.addEventListener('message', function(event){
      const msg = event.data;
      switch(msg.type){
        case 'init':
          appState.changes = msg.changes || [];
          appState.stats   = msg.stats;
          renderStats(msg.stats);
          renderFeed(msg.changes);
          break;

        case 'statsUpdate':
          appState.stats = msg.stats;
          renderStats(msg.stats);
          break;

        case 'fileChangeAdded':
          appendChange(msg.change);
          if(appState.stats){
            appState.stats.fileChangeCount=(appState.stats.fileChangeCount||0)+1;
          }
          break;

        case 'confidenceUpdate':
          updateConfidence(msg.changeId, msg.confidence);
          break;

        case 'sessionCleared':
          appState.changes=[];
          appState.stats=null;
          renderFeed([]);
          renderStats({isRunning:false,startTime:null,durationMs:0,fileChangeCount:0,
            totalAddedLines:0,totalRemovedLines:0,totalEstimatedTokens:0,
            totalEstimatedCostUsd:0,uniqueFilesChanged:0});
          break;

        case 'sessionStarted':
          if(appState.stats) appState.stats.isRunning=true;
          renderStats(appState.stats);
          break;

        case 'sessionStopped':
          if(appState.stats) appState.stats.isRunning=false;
          renderStats(appState.stats);
          break;

        case 'promptDetected':
          // Auto-captured from Claude Code session — open section and populate
          document.getElementById('prompt-section').classList.add('open');
          document.getElementById('prompt-input').value=msg.prompt;
          document.getElementById('prompt-result').style.display='none';
          document.getElementById('auto-badge').style.display='inline';
          document.getElementById('prompt-section').scrollIntoView({behavior:'smooth',block:'nearest'});
          break;

        case 'promptScoring':
          document.getElementById('btn-score-prompt').disabled=true;
          document.getElementById('scoring-hint').style.display='inline';
          break;

        case 'promptScoreResult':
          document.getElementById('btn-score-prompt').disabled=false;
          document.getElementById('scoring-hint').style.display='none';
          renderPromptScore(msg.score);
          break;
      }
      saveState();
    });

    // Hide auto-badge when user manually edits
    document.getElementById('prompt-input').addEventListener('input',function(){
      document.getElementById('auto-badge').style.display='none';
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    if(appState.stats)  renderStats(appState.stats);
    if(appState.changes.length>0) renderFeed(appState.changes);

    // Tell extension we are ready — it will reply with 'init'
    vscode.postMessage({type:'ready'});
  })();</script>
</body>
</html>`;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }
}
