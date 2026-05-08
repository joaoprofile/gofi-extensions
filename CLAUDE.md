# Gofi Extension — Claude Context

Real-time diff tracking, token/cost estimation, and prompt scoring for Claude Code sessions. Rendered as a VS Code sidebar panel.

## Build & install

```bash
npm run compile                                                        # esbuild → dist/extension.js
npm run type-check                                                     # tsc --noEmit
npm run package                                                        # compile + vsce → .vsix
code --install-extension gofi-extension-0.1.0.vsix --force           # install
# Then: Ctrl+Shift+P → Developer: Reload Window
```

## Key files

| File | Role |
|---|---|
| `src/extension.ts` | Activation, command registration, wires all services |
| `src/SessionPanel.ts` | `WebviewViewProvider`; `_buildHtml()` builds the sidebar HTML |
| `media/webview.js` | All webview-side JS (external file, loaded via `asWebviewUri`) |
| `src/DiffTracker.ts` | Git-based diff tracking; computes estimated tokens/cost from diff text |
| `src/ContextReadTracker.ts` | Detects context-only reads from JSONL; tracks actual API token usage |
| `src/ConfidenceService.ts` | AI scoring via Anthropic SDK or claude CLI fallback |
| `src/PromptWatcher.ts` | Watches `~/.claude/projects/<hash>/*.jsonl` for new prompts |
| `src/FSWatcher.ts` | VS Code file system watcher with debounce |
| `src/HookWatcher.ts` | Reads Claude Code hook events JSONL |
| `src/TokenEstimator.ts` | `estimateTokens(text)` and `estimateCost(tokens, costPerMillion)` helpers |
| `src/types.ts` | All shared TypeScript interfaces (`SessionStats`, `FileChange`, `SavedSession`, etc.) |

## Architecture

```
extension.ts
  ├── DiffTracker          — file changes → estimated tokens/cost (diff-based)
  ├── ContextReadTracker   — JSONL reads → actual API token usage
  ├── ConfidenceService    — per-diff AI scoring
  ├── PromptWatcher        — detects when user submits a prompt
  ├── FSWatcher            — file system change events
  └── SessionPanel         — webview sidebar
        └── media/webview.js  — pure JS, no framework
```

## Cost/token accounting — important invariant

Two independent cost sources must **always be combined** when displaying or archiving totals:

- `DiffTracker.stats.totalEstimatedCostUsd` — diff-size estimates
- `ContextReadTracker.entries[].estimatedCostUsd` — actual API usage from JSONL

`archiveSession()` in `extension.ts` merges context read totals into `stats` before saving to history.  
`renderStats()` in `webview.js` adds `readsTotalCost` / `readsTotalTokens` to the displayed values.  
`sessionsTotalCost` in `webview.js` tracks the running total shown in the Past Sessions header.

## Webview UI sections (all collapsible)

All sections share the same expand-icon pattern (`›` rotates 90° when open via `.open` class):

| Section | ID | Default | Header extras |
|---|---|---|---|
| Current Session | `feed-section` | open | file count badge (pings orange on new change) |
| Latest Prompt | `prompt-section` | open | — |
| Context Reads | `reads-section` | hidden until data | count badge + total cost |
| Past Sessions | `sessions-section` | hidden until data | count badge + total cost |

## CSP rules — two critical gotchas

1. **No inline `<script>` blocks** — silently blocked by VS Code webviews. Always load JS via `asWebviewUri`.
2. **No inline `style=""` attributes** — `style-src 'nonce-...'` allows `<style nonce="...">` tags but blocks `style=""` on elements. Use CSS classes (e.g. `.hidden { display: none; }`) defined in the nonce-protected `<style>` block. JS can still set `.style.*` properties at runtime.

CSP in use: `default-src 'none'; style-src 'nonce-${nonce}'; script-src ${webview.cspSource}`

## Provider badge

Dark pill (`background: #1a1a1a`, `color: #e8e8e8`, `font-weight: 600`) containing an inline SVG of the Claude asterisk logo (8 rounded rects rotated 45° apart, `fill: #D97757`) + "Claude" text.
