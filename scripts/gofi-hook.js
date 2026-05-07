#!/usr/bin/env node
'use strict';

/**
 * Claude Code PostToolUse hook script.
 * Reads a hook event from stdin (JSON), appends a timestamped line to the JSONL log file.
 * Registered via .claude/settings.json or ~/.claude/settings.json.
 *
 * Must exit 0 — a non-zero exit would abort the Claude Code tool call.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const logPath = process.env.GOFI_EVENTS_PATH
  || path.join(os.homedir(), '.claude', 'gofi-events.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw);
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    // Never crash the hook — write error to stderr but exit 0
    process.stderr.write('[gofi-hook] ' + String(err) + '\n');
  }
  process.exit(0);
});
