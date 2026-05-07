# Gofi — AI Change Monitor

A VSCode sidebar extension that gives you a real-time window into what an AI coding assistant (Claude Code, or any tool that writes files) is doing while it works.

For every file touched, Gofi shows the **unified diff**, an **estimated token count**, an **estimated cost**, and — if you connect an Anthropic API key — a **confidence score** assessing the correctness and quality of the change.

It also lets you **score a prompt before you run it**: paste a plan into the sidebar and get a Clarity + Completeness breakdown with a list of detected issues.

---

## Features

| Feature | Description |
|---------|-------------|
| **Real-time diff feed** | Every file create/modify/delete appears in the sidebar with a colored unified diff (expandable) |
| **Token estimation** | Diff character count ÷ 4 → token estimate per file and session total |
| **Cost estimation** | Configurable cost-per-million multiplier (default: $3.00/M, Sonnet input pricing) |
| **Post-change confidence** | Optional — calls `claude-haiku` after each file change, returns correctness % + quality % + rationale |
| **Pre-execution prompt scoring** | Paste any plan/prompt → get Clarity %, Completeness %, and a list of gaps before you run it |
| **Claude Code hook enrichment** | When Claude Code's `PostToolUse` hook is installed, each diff entry also shows the tool name (Write / Edit / MultiEdit) |
| **Session management** | Start, stop, clear sessions; running duration and aggregate stats always visible |
| **Provider-agnostic design** | `AIProvider` interface can be implemented for OpenAI, Gemini, or any other backend |

---

## Installation

### From source

```bash
git clone <repo>
cd gofi-extension
npm install
npm run compile
```

Then press **F5** in VSCode to open an Extension Development Host, or package with:

```bash
npx vsce package
# installs the generated .vsix via: code --install-extension gofi-extension-0.1.0.vsix
```

---

## Setup

### 1. Open the sidebar

Click the **Gofi icon** in the VSCode activity bar (left panel). The Change Monitor panel will open.

### 2. Start a session

Click **Start** in the sidebar controls. The status bar turns green and animates. Gofi begins watching your workspace for file changes.

> By default the session starts automatically on extension activation. You can change this with `gofi.autoStart: false`.

### 3. Run Claude Code (or any AI tool)

Work as normal. Every file that gets written shows up in the feed with:
- A type badge (`CRE` / `MOD` / `DEL`)
- The relative file path (clickable — opens the file in the editor)
- Lines added / removed / estimated tokens
- Timestamp
- An expandable unified diff

### 4. Inspect a diff

Click any entry header to expand it. The diff view shows colored hunks with ±3 lines of context. Click the file path to jump directly to the file.

---

## Prompt Scoring (pre-execution)

Use this before handing a plan to Claude Code to catch gaps early.

1. Click **Analyze Prompt** in the sidebar to expand the section
2. Paste your plan or prompt into the text area
3. Click **Score Prompt**

Results appear inline:

```
[ Clarity  85% ]  [ Completeness  62% ]
⚠ JWT secret management not specified
⚠ No rollback strategy mentioned for the DB migration
⚠ Target framework not identified (Express vs Fastify)
```

Scores use the same color scale as confidence badges:
- **Green** ≥ 80
- **Yellow** 60–79
- **Red** < 60

> Requires an Anthropic API key. See [Confidence Scoring](#confidence-scoring-post-change) below.

---

## Confidence Scoring (post-change)

After each file change, Gofi can call `claude-haiku-4-5-20251001` to assess the diff and return:

- **Correctness** — likelihood the change is functionally correct (0–100)
- **Quality** — code quality and best practices (0–100)
- **Rationale** — one-sentence explanation

### Enable it

Run `Cmd+Shift+P` → **Gofi: Set Anthropic API Key**. This saves the key to VSCode global settings and enables confidence scoring automatically.

Alternatively, set:
```json
"gofi.anthropicApiKey": "sk-ant-...",
"gofi.enableConfidenceScoring": true
```

Or export the key as an environment variable before launching VSCode:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Confidence scores appear inside the expanded diff view for each entry. There is a configurable debounce (default 2 s) so rapid saves don't trigger a call per keystroke.

---

## Claude Code Hook Enrichment

When the hook is installed, each diff entry gains a tool-name badge (`Write`, `Edit`, `MultiEdit`) showing exactly which Claude Code operation produced the change.

### Install the hook

Run `Cmd+Shift+P` → **Gofi: Install Claude Code Hook**

This:
1. Copies `scripts/gofi-hook.js` to `~/.claude/gofi-hook.js`
2. Patches `~/.claude/settings.json` with a `PostToolUse` entry:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node ~/.claude/gofi-hook.js" }]
      }
    ]
  }
}
```

Hook events are appended to `~/.claude/gofi-events.jsonl`. Gofi watches this file and correlates events with FS-watcher detections within a 3-second window.

---

## Configuration

All settings are under the `gofi.*` namespace.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gofi.autoStart` | boolean | `true` | Start monitoring automatically on extension activation |
| `gofi.anthropicApiKey` | string | `""` | Anthropic API key. Uses `ANTHROPIC_API_KEY` env var if empty |
| `gofi.enableConfidenceScoring` | boolean | `false` | Call Claude Haiku after each file change |
| `gofi.confidenceDebounceMs` | number | `2000` | Ms to wait after the last change before calling the API |
| `gofi.costPerMillionTokens` | number | `3.0` | USD per million tokens for cost estimation |
| `gofi.excludeGlobs` | string[] | see below | Glob patterns to exclude from file watching |
| `gofi.hookEventsPath` | string | `""` | Custom path for Claude Code hook events JSONL (default: `~/.claude/gofi-events.jsonl`) |
| `gofi.aiProvider` | `"claude"` \| `"none"` | `"claude"` | AI provider for confidence and prompt scoring |

Default excluded globs:
```json
["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/.vscode/**", "**/*.log"]
```

---

## Commands

| Command | Description |
|---------|-------------|
| `Gofi: Start Session` | Begin monitoring file changes |
| `Gofi: Stop Session` | Pause monitoring (retains session data) |
| `Gofi: Clear Session` | Wipe all session data and stop monitoring |
| `Gofi: Install Claude Code Hook` | Patch `~/.claude/settings.json` with the PostToolUse hook |
| `Gofi: Set Anthropic API Key` | Securely save your API key and enable confidence scoring |

---

## How detection works

Gofi uses two complementary mechanisms:

**File system watcher** (always on)
- `vscode.workspace.createFileSystemWatcher` per workspace folder
- 100 ms debounce per file to coalesce rapid writes
- On every detected change: reads the new file content, diffs it against the cached old content (LCS algorithm, up to 2 000 lines), then updates the cache

**Claude Code hooks** (optional enrichment)
- The hook script appends a JSONL line to `~/.claude/gofi-events.jsonl` after every Write/Edit/MultiEdit call
- Gofi watches that file and backfills the `tool name` onto the matching file-change entry within 3 seconds

If a file has never been cached (opened in the editor or changed since the extension started), the first diff shows the entire new content as "added". Subsequent changes to the same file show accurate before/after diffs.

---

## Adding another AI provider

Implement the `AIProvider` interface in [src/types.ts](src/types.ts):

```typescript
import { AIProvider, ConfidenceResult, FileChange, PromptScore } from './types';

export class MyProvider implements AIProvider {
  readonly name = 'myprovider';

  isConfigured(): boolean { /* check for API key */ }

  async scoreChange(change: FileChange): Promise<ConfidenceResult | null> {
    // analyze change.hunks, return { correctness, quality, rationale, modelUsed, latencyMs }
  }

  async scorePrompt(prompt: string): Promise<PromptScore | null> {
    // analyze prompt, return { clarity, completeness, issues }
  }
}
```

Then swap it in [src/extension.ts](src/extension.ts) where `provider` is constructed.

---

## Project structure

```
gofi-extension/
├── src/
│   ├── extension.ts          Entry point — wires all components together
│   ├── types.ts              Shared TypeScript interfaces
│   ├── DiffTracker.ts        File content cache + LCS diff engine + session state
│   ├── FSWatcher.ts          VSCode file system watcher (debounced)
│   ├── HookWatcher.ts        Tails ~/.claude/gofi-events.jsonl for hook events
│   ├── ConfidenceService.ts  Claude API wrapper (post-change + prompt scoring)
│   ├── TokenEstimator.ts     Token and cost estimation utilities
│   └── SessionPanel.ts       WebView sidebar — all HTML/CSS/JS inline
├── scripts/
│   └── gofi-hook.js          Claude Code PostToolUse hook script
└── resources/
    └── icon.svg              Activity bar icon
```
