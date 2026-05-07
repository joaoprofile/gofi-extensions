(function () {
  'use strict';

  window.onerror = function (msg, _src, line) {
    var txt = document.getElementById('status-text');
    if (txt) { txt.textContent = 'JS error (line ' + line + '): ' + msg; }
  };

  const vscode = acquireVsCodeApi();
  let appState = vscode.getState() || { changes: [], stats: null, savedSessions: [] };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtNum(n) {
    if (n >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
    if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'k'; }
    return String(n);
  }

  function fmtCost(usd) {
    if (usd < 1e-6) { return '$0.00'; }
    if (usd < 1e-4) { return '$' + usd.toFixed(6); }
    if (usd < 0.01) { return '$' + usd.toFixed(4); }
    return '$' + usd.toFixed(2);
  }

  function fmtDur(ms) {
    if (!ms) { return '—'; }
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) { return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function scoreClass(n) { return n >= 80 ? 'hi' : n >= 60 ? 'md' : 'lo'; }

  // ── Render stats ───────────────────────────────────────────────────────────

  function renderStats(stats) {
    if (!stats) { return; }
    const sFiles = document.getElementById('s-files');
    const sAdded = document.getElementById('s-added');
    const sRemoved = document.getElementById('s-removed');
    const sTokens = document.getElementById('s-tokens');
    const sCost = document.getElementById('s-cost');
    const sDur = document.getElementById('s-dur');
    if (sFiles) { sFiles.textContent = stats.uniqueFilesChanged; }
    if (sAdded) { sAdded.textContent = '+' + stats.totalAddedLines; }
    if (sRemoved) { sRemoved.textContent = '−' + stats.totalRemovedLines; }
    if (sTokens) { sTokens.textContent = fmtNum(stats.totalEstimatedTokens); }
    if (sCost) { sCost.textContent = fmtCost(stats.totalEstimatedCostUsd); }
    if (sDur) { sDur.textContent = fmtDur(stats.durationMs); }

    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    const start = document.getElementById('btn-start');
    const stop = document.getElementById('btn-stop');
    if (!dot || !txt || !start || !stop) { return; }

    if (stats.isRunning) {
      dot.className = 'dot active';
      txt.textContent = 'Monitoring…';
      start.disabled = true;
      stop.disabled = false;
    } else {
      dot.className = 'dot';
      txt.textContent = stats.startTime ? 'Session paused' : 'Not monitoring';
      start.disabled = false;
      stop.disabled = true;
    }
  }

  // ── Build diff HTML ────────────────────────────────────────────────────────

  function buildDiffHtml(change) {
    if (change.skippedDiff) {
      return '<div class="diff-skipped">File too large to diff — ' +
        change.addedLines + ' new / ' + change.removedLines + ' old lines</div>';
    }
    if (!change.hunks || change.hunks.length === 0) {
      return '<div class="diff-skipped">No visible changes in this file</div>';
    }
    return change.hunks.map(function (hunk) {
      const lns = hunk.lines.map(function (l) {
        const pfx = l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
        const ln = l.lineNoNew != null ? l.lineNoNew : (l.lineNoOld != null ? l.lineNoOld : '');
        return '<div class="dl ' + esc(l.type) + '">' +
          '<span class="ln">' + ln + '</span>' +
          '<span class="pfx">' + pfx + '</span>' +
          '<span class="code">' + esc(l.content) + '</span>' +
          '</div>';
      }).join('');
      return '<div class="hunk-hdr">' + esc(hunk.header) + '</div>' + lns;
    }).join('');
  }

  // ── Build plain-text diff for review prompt ────────────────────────────────

  function buildDiffText(change) {
    if (change.skippedDiff) { return '(file too large to diff)'; }
    if (!change.hunks || change.hunks.length === 0) { return '(no visible changes)'; }
    return change.hunks.map(function (hunk) {
      const lines = hunk.lines.map(function (l) {
        const pfx = l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
        return pfx + l.content;
      }).join('\n');
      return hunk.header + '\n' + lines;
    }).join('\n');
  }

  function buildReviewPrompt(change, reviewText) {
    const diff = buildDiffText(change);
    let prompt = 'Please review this change to `' + change.relPath + '` (' + change.changeType + '):\n\n```diff\n' + diff + '\n```';
    if (reviewText) {
      prompt += '\n\nMy review notes:\n' + reviewText + '\n\nPlease address the above.';
    } else {
      prompt += '\n\nPlease review this change and let me know if anything should be improved.';
    }
    return prompt;
  }

  // ── Build confidence HTML ──────────────────────────────────────────────────

  function buildConfHtml(conf) {
    if (!conf) { return '<span class="ctext">Awaiting analysis…</span>'; }
    return '<span class="cscore ' + scoreClass(conf.correctness) + '">✓ ' + conf.correctness + '%</span>' +
      '<span class="cscore ' + scoreClass(conf.quality) + '">★ ' + conf.quality + '%</span>' +
      '<span class="ctext">' + esc(conf.rationale) + '</span>';
  }

  // ── Build entry element ────────────────────────────────────────────────────

  function buildEntry(change) {
    const div = document.createElement('div');
    div.className = 'entry';
    div.id = 'entry-' + change.id;

    const hookTag = change.hookContext
      ? '<span class="hook-tag">' + esc(change.hookContext.toolName) + '</span>'
      : '';

    const confSection = '<div class="conf-bar" id="conf-' + change.id + '">' + buildConfHtml(change.confidence || null) + '</div>';

    div.innerHTML =
      '<div class="entry-header">' +
        '<span class="badge ' + esc(change.changeType) + '">' + change.changeType.slice(0, 3).toUpperCase() + '</span>' +
        '<span class="entry-path" data-open-file="' + esc(change.filePath) + '" title="' + esc(change.filePath) + '">' + esc(change.relPath) + '</span>' +
        '<span class="entry-stats">' +
          '<span class="s-add">+' + change.addedLines + '</span>' +
          '<span class="s-rem">−' + change.removedLines + '</span>' +
          '<span class="s-tok">~' + fmtNum(change.estimatedTokens) + 't</span>' +
        '</span>' +
        hookTag +
        '<span class="entry-time">' + fmtTime(change.timestamp) + '</span>' +
        '<span class="expand-icon">›</span>' +
      '</div>' +
      confSection +
      '<div class="diff-view" id="diff-' + change.id + '">' + buildDiffHtml(change) + '</div>' +
      '<div class="review-area">' +
        '<textarea class="review-input" placeholder="Add review notes or corrections…"></textarea>' +
        '<div class="review-actions">' +
          '<button class="primary btn-copy-review">Copy as Prompt</button>' +
          '<span class="copy-toast">✓ Copied!</span>' +
        '</div>' +
      '</div>';

    return div;
  }

  // ── Render full feed ───────────────────────────────────────────────────────

  function renderFeed(changes) {
    const feed = document.getElementById('feed');
    if (!feed) { return; }
    feed.innerHTML = '';
    if (!changes || changes.length === 0) {
      feed.innerHTML = '<div class="empty-state">No file changes detected yet.<br>Start a monitoring session, then run Claude Code.</div>';
      return;
    }
    changes.slice().reverse().forEach(function (c) { feed.appendChild(buildEntry(c)); });
  }

  // ── Append single new change ───────────────────────────────────────────────

  function appendChange(change) {
    const feed = document.getElementById('feed');
    if (!feed) { return; }
    const empty = feed.querySelector('.empty-state');
    if (empty) { empty.remove(); }
    feed.insertBefore(buildEntry(change), feed.firstChild);
    appState.changes.push(change);
    saveState();
  }

  // ── Toggle expand ──────────────────────────────────────────────────────────

  function toggleEntry(entry) {
    entry.classList.toggle('open', !entry.classList.contains('open'));
  }

  // ── Prompt score ───────────────────────────────────────────────────────────

  function renderPromptScore(score) {
    const result = document.getElementById('prompt-result');
    if (!result) { return; }
    if (!score) {
      result.innerHTML = '<span class="scoring-hint" style="color:var(--vscode-descriptionForeground)">Run <strong>Gofi: Set Anthropic API Key</strong> (⌘⇧P) to enable prompt scoring.</span>';
      result.style.display = 'block';
      return;
    }
    const clar = document.getElementById('pr-clarity');
    if (clar) { clar.className = 'cscore ' + scoreClass(score.clarity); clar.textContent = 'Clarity ' + score.clarity + '%'; }
    const comp = document.getElementById('pr-completeness');
    if (comp) { comp.className = 'cscore ' + scoreClass(score.completeness); comp.textContent = 'Completeness ' + score.completeness + '%'; }
    const issues = document.getElementById('pr-issues');
    if (issues) {
      issues.innerHTML = score.issues.length
        ? score.issues.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('')
        : '<li style="color:var(--vscode-descriptionForeground)">No issues detected</li>';
    }
    result.style.display = 'block';
  }

  // ── Context reads ──────────────────────────────────────────────────────────

  let readsTotalCost = 0;

  function appendRead(entry) {
    readsTotalCost += entry.estimatedCostUsd;
    const readsCount = document.getElementById('reads-count');
    const readsBody = document.getElementById('reads-body');
    const readsTotal = document.getElementById('reads-total');
    const readsSection = document.getElementById('reads-section');
    if (!readsCount || !readsBody || !readsTotal || !readsSection) { return; }
    readsCount.textContent = String(readsBody.childElementCount + 1);
    readsTotal.textContent = fmtCost(readsTotalCost);
    readsSection.style.display = '';
    const div = document.createElement('div');
    div.className = 'read-entry';
    div.innerHTML =
      '<span class="read-time">' + fmtTime(entry.timestamp) + '</span>' +
      '<span class="read-prompt">' + esc(entry.prompt) + '</span>' +
      '<span class="read-tokens">' + fmtNum(entry.estimatedTokens) + 't</span>' +
      '<span class="read-cost">' + fmtCost(entry.estimatedCostUsd) + '</span>';
    readsBody.insertBefore(div, readsBody.firstChild);
  }

  function clearReads() {
    readsTotalCost = 0;
    const readsBody = document.getElementById('reads-body');
    const readsCount = document.getElementById('reads-count');
    const readsTotal = document.getElementById('reads-total');
    const readsSection = document.getElementById('reads-section');
    if (readsBody) { readsBody.innerHTML = ''; }
    if (readsCount) { readsCount.textContent = '0'; }
    if (readsTotal) { readsTotal.textContent = '$0.00'; }
    if (readsSection) { readsSection.style.display = 'none'; }
  }

  // ── Past sessions ──────────────────────────────────────────────────────────

  function buildSessionRow(session) {
    const s = session.stats;
    const div = document.createElement('div');
    div.className = 'session-row';
    div.dataset.sessionId = session.id;
    const d = new Date(session.savedAt);
    const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML =
      '<span class="session-date">' + esc(dateStr) + '</span>' +
      '<span class="session-meta">' +
        '<span class="session-stat">' + s.uniqueFilesChanged + 'f</span>' +
        '<span class="s-add">+' + s.totalAddedLines + '</span>' +
        '<span class="s-rem">−' + s.totalRemovedLines + '</span>' +
        '<span class="session-stat">~' + fmtNum(s.totalEstimatedTokens) + 't</span>' +
      '</span>' +
      '<span class="session-cost">' + fmtCost(s.totalEstimatedCostUsd) + '</span>' +
      '<button class="session-del" title="Delete session" data-del-session="' + esc(session.id) + '">×</button>';
    return div;
  }

  function renderSessions(sessions) {
    const body = document.getElementById('sessions-body');
    const section = document.getElementById('sessions-section');
    if (!body || !section) { return; }
    body.innerHTML = '';
    if (!sessions || sessions.length === 0) {
      section.style.display = 'none';
      return;
    }
    sessions.forEach(function (s) { body.appendChild(buildSessionRow(s)); });
    const count = document.getElementById('sessions-count');
    if (count) { count.textContent = String(sessions.length); }
    section.style.display = '';
  }

  function prependSession(session) {
    const body = document.getElementById('sessions-body');
    const section = document.getElementById('sessions-section');
    const count = document.getElementById('sessions-count');
    if (!body || !section) { return; }
    body.insertBefore(buildSessionRow(session), body.firstChild);
    if (count) { count.textContent = String(parseInt(count.textContent || '0', 10) + 1); }
    section.style.display = '';
  }

  function removeSessionRow(sessionId) {
    const row = document.querySelector('[data-session-id="' + sessionId + '"]');
    if (row) { row.remove(); }
    const body = document.getElementById('sessions-body');
    const section = document.getElementById('sessions-section');
    const count = document.getElementById('sessions-count');
    const remaining = body ? body.childElementCount : 0;
    if (count) { count.textContent = String(remaining); }
    if (section && remaining === 0) { section.style.display = 'none'; }
  }

  // ── Update confidence ──────────────────────────────────────────────────────

  function updateConfidence(changeId, conf) {
    const bar = document.getElementById('conf-' + changeId);
    if (bar) { bar.innerHTML = buildConfHtml(conf); }
    const c = appState.changes.find(function (x) { return x.id === changeId; });
    if (c) { c.confidence = conf; saveState(); }
  }

  // ── State persistence ──────────────────────────────────────────────────────

  function saveState() {
    vscode.setState({
      changes: appState.changes.slice(-200),
      stats: appState.stats
    });
  }

  // ── Button handlers ────────────────────────────────────────────────────────

  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnClear = document.getElementById('btn-clear');

  if (btnStart) { btnStart.addEventListener('click', function () { vscode.postMessage({ type: 'startSession' }); }); }
  if (btnStop) { btnStop.addEventListener('click', function () { vscode.postMessage({ type: 'stopSession' }); }); }
  if (btnClear) { btnClear.addEventListener('click', function () { vscode.postMessage({ type: 'clearSession' }); }); }

  // ── Event delegation ───────────────────────────────────────────────────────

  document.addEventListener('click', function (e) {
    const fileEl = e.target.closest('.entry-path[data-open-file]');
    if (fileEl) { e.stopPropagation(); vscode.postMessage({ type: 'openFile', filePath: fileEl.dataset.openFile }); return; }

    const header = e.target.closest('.entry-header');
    if (header) { toggleEntry(header.closest('.entry')); return; }

    const promptHdr = e.target.closest('.prompt-hdr');
    if (promptHdr) { const s = document.getElementById('prompt-section'); if (s) { s.classList.toggle('open'); } return; }

    const readsHdr = e.target.closest('.reads-hdr');
    if (readsHdr) { const s = document.getElementById('reads-section'); if (s) { s.classList.toggle('open'); } return; }

    const sessionsHdr = e.target.closest('.sessions-hdr');
    if (sessionsHdr) { const s = document.getElementById('sessions-section'); if (s) { s.classList.toggle('open'); } return; }

    const delBtn = e.target.closest('[data-del-session]');
    if (delBtn) { e.stopPropagation(); vscode.postMessage({ type: 'deleteSession', sessionId: delBtn.dataset.delSession }); return; }

    const copyBtn = e.target.closest('.btn-copy-review');
    if (copyBtn) {
      const entryEl = copyBtn.closest('.entry');
      if (!entryEl) { return; }
      const changeId = entryEl.id.replace('entry-', '');
      const reviewInput = entryEl.querySelector('.review-input');
      const reviewText = reviewInput ? reviewInput.value.trim() : '';
      const change = appState.changes.find(function (c) { return c.id === changeId; });
      if (!change) { return; }
      vscode.postMessage({ type: 'copyReview', text: buildReviewPrompt(change, reviewText) });
      const toast = copyBtn.nextElementSibling;
      if (toast && toast.classList.contains('copy-toast')) {
        toast.style.display = 'inline';
        setTimeout(function () { toast.style.display = 'none'; }, 2000);
      }
    }
  });

  // ── Message handler ────────────────────────────────────────────────────────

  var initReceived = false;
  var retryTimer;

  window.addEventListener('message', function (event) {
    const msg = event.data;
    try {
      switch (msg.type) {
        case 'init':
          initReceived = true;
          clearInterval(retryTimer);
          appState.changes = msg.changes || [];
          appState.stats = msg.stats;
          renderStats(msg.stats);
          renderFeed(msg.changes);
          if (msg.contextReads && msg.contextReads.length > 0) {
            msg.contextReads.forEach(function (entry) { appendRead(entry); });
          }
          renderSessions(msg.savedSessions || []);
          break;
        case 'statsUpdate':
          appState.stats = msg.stats;
          renderStats(msg.stats);
          break;
        case 'fileChangeAdded':
          appendChange(msg.change);
          if (appState.stats) { appState.stats.fileChangeCount = (appState.stats.fileChangeCount || 0) + 1; }
          if (soundEnabled) { playPing(); }
          break;
        case 'confidenceUpdate':
          updateConfidence(msg.changeId, msg.confidence);
          break;
        case 'contextReadAdded':
          appendRead(msg.entry);
          break;
        case 'contextReadsCleared':
          clearReads();
          break;
        case 'sessionArchived':
          prependSession(msg.session);
          break;
        case 'sessionDeleted':
          removeSessionRow(msg.sessionId);
          break;
        case 'sessionCleared':
          appState.changes = [];
          appState.stats = null;
          renderFeed([]);
          clearReads();
          renderStats({ isRunning: false, startTime: null, durationMs: 0, fileChangeCount: 0, totalAddedLines: 0, totalRemovedLines: 0, totalEstimatedTokens: 0, totalEstimatedCostUsd: 0, uniqueFilesChanged: 0 });
          break;
        case 'sessionStarted':
          if (appState.stats) { appState.stats.isRunning = true; }
          renderStats(appState.stats);
          break;
        case 'sessionStopped':
          if (appState.stats) { appState.stats.isRunning = false; }
          renderStats(appState.stats);
          break;
        case 'promptDetected': {
          const pt = document.getElementById('prompt-text');
          if (pt) { pt.textContent = msg.prompt; pt.classList.remove('empty'); }
          const pr = document.getElementById('prompt-result');
          if (pr) { pr.style.display = 'none'; }
          const ps = document.getElementById('prompt-section');
          if (ps) { ps.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
          break;
        }
        case 'promptScoring': {
          const hint = document.getElementById('scoring-hint');
          if (hint) { hint.style.display = 'inline'; }
          break;
        }
        case 'promptScoreResult': {
          const hint = document.getElementById('scoring-hint');
          if (hint) { hint.style.display = 'none'; }
          renderPromptScore(msg.score);
          break;
        }
      }
      saveState();
    } catch (err) {
      const txt = document.getElementById('status-text');
      if (txt) { txt.textContent = 'Error: ' + String(err); }
    }
  });

  // ── Notification sound ─────────────────────────────────────────────────────

  let soundEnabled = false;

  function playPing() {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      [[1047, now, 0.3], [1319, now + 0.12, 0.2]].forEach(function (args) {
        const freq = args[0], start = args[1], vol = args[2];
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(vol, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
        osc.start(start);
        osc.stop(start + 0.45);
      });
      setTimeout(function () { ctx.close(); }, 700);
    } catch (e) { /* AudioContext may not be available in all webview environments */ }
  }

  const btnSound = document.getElementById('btn-sound');
  const iconMute = document.getElementById('icon-mute');
  const iconSound = document.getElementById('icon-sound');
  if (btnSound) {
    btnSound.addEventListener('click', function () {
      soundEnabled = !soundEnabled;
      if (iconMute) { iconMute.style.display = soundEnabled ? 'none' : ''; }
      if (iconSound) { iconSound.style.display = soundEnabled ? '' : 'none'; }
      btnSound.classList.toggle('on', soundEnabled);
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  if (appState.stats) { renderStats(appState.stats); }
  if (appState.changes && appState.changes.length > 0) { renderFeed(appState.changes); }

  vscode.postMessage({ type: 'ready' });

  retryTimer = setInterval(function () {
    if (initReceived) { clearInterval(retryTimer); return; }
    vscode.postMessage({ type: 'ready' });
  }, 500);

  // Stop retrying after 5 seconds
  setTimeout(function () { clearInterval(retryTimer); }, 5000);

}());
