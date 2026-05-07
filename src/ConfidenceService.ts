import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ConfidenceResult, FileChange, PromptScore } from './types';
import { rawDiffText } from './TokenEstimator';

export class ClaudeConfidenceProvider implements AIProvider {
  readonly name = 'claude';

  private _client: Anthropic | null = null;
  private readonly _cache = new Map<string, ConfidenceResult>();
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  isConfigured(): boolean {
    return true;
  }

  scheduleScore(
    change: FileChange,
    onResult: (changeId: string, result: ConfidenceResult) => void
  ): void {
    const debounceMs = vscode.workspace.getConfiguration('gofi').get<number>('confidenceDebounceMs', 2000);

    const existing = this._debounceTimers.get(change.id);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(async () => {
      this._debounceTimers.delete(change.id);
      const result = await this.scoreChange(change);
      if (result) { onResult(change.id, result); }
    }, debounceMs);

    this._debounceTimers.set(change.id, timer);
  }

  async scoreChange(change: FileChange): Promise<ConfidenceResult | null> {
    if (this._cache.has(change.id)) { return this._cache.get(change.id)!; }

    const diffText = rawDiffText(change.hunks);
    if (!diffText.trim()) { return null; }

    try {
      const t0 = Date.now();
      const system = 'You are a code review assistant. Respond with only a JSON object, no markdown.';
      const user = `Analyze this code diff for the file "${change.relPath}" and respond with ONLY this JSON:\n{"correctness":0-100,"quality":0-100,"rationale":"one sentence"}\n\nDiff:\n${diffText.slice(0, 4000)}`;

      const text = await this._callModel(system, user, 150);
      if (!text) { return null; }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { return null; }

      const parsed = JSON.parse(jsonMatch[0]);
      const result: ConfidenceResult = {
        correctness: Math.min(100, Math.max(0, Math.round(Number(parsed.correctness)))),
        quality: Math.min(100, Math.max(0, Math.round(Number(parsed.quality)))),
        rationale: String(parsed.rationale ?? '').slice(0, 200),
        modelUsed: 'claude-haiku-4-5-20251001',
        latencyMs: Date.now() - t0,
      };

      this._cache.set(change.id, result);
      return result;
    } catch (err) {
      console.error('[Gofi] Confidence scoring failed:', err);
      return null;
    }
  }

  private async _callModel(system: string, user: string, maxTokens: number): Promise<string | null> {
    const key = vscode.workspace.getConfiguration('gofi').get<string>('anthropicApiKey', '')
      || process.env.ANTHROPIC_API_KEY || '';

    if (key) {
      if (!this._client) {
        this._client = new Anthropic({ apiKey: key });
      }
      const response = await this._client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return response.content[0].type === 'text' ? response.content[0].text.trim() : null;
    }

    // No API key — use Claude Code OAuth credentials directly
    return this._callWithClaudeAuth(system, user, maxTokens);
  }

  private async _callWithClaudeAuth(system: string, user: string, maxTokens: number): Promise<string | null> {
    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const { accessToken, expiresAt } = creds?.claudeAiOauth ?? {};
      if (!accessToken) { return null; }
      if (expiresAt && Date.now() > new Date(expiresAt).getTime()) { return null; }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });

      if (!resp.ok) { return null; }
      const data = await resp.json() as { content: Array<{ type: string; text: string }> };
      return data.content?.[0]?.text?.trim() ?? null;
    } catch {
      return null;
    }
  }

  async scorePrompt(prompt: string): Promise<PromptScore | null> {
    try {
      const system = 'You are a code planning assistant. You must respond with ONLY raw JSON — no markdown, no code fences, no extra text.';
      const user = `Analyze the LATEST USER message below for clarity and completeness as a prompt to an AI coding assistant. Earlier turns provide context — a short follow-up can be perfectly clear if the session already established the goal.\nRespond with ONLY this JSON (max 2 issues, max 6 words each): {"clarity":0-100,"completeness":0-100,"issues":["short issue"]}\n\nConversation:\n${prompt.slice(0, 3000)}`;

      const text = await this._callModel(system, user, 120);
      if (!text) { return null; }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { return null; }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        clarity: Math.min(100, Math.max(0, Math.round(Number(parsed.clarity)))),
        completeness: Math.min(100, Math.max(0, Math.round(Number(parsed.completeness)))),
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).slice(0, 10) : [],
      };
    } catch (err) {
      console.error('[Gofi] Prompt scoring failed:', err);
      return null;
    }
  }

  dispose(): void {
    for (const t of this._debounceTimers.values()) { clearTimeout(t); }
    this._debounceTimers.clear();
  }
}

export class NoOpProvider implements AIProvider {
  readonly name = 'none';
  isConfigured(): boolean { return false; }
  async scoreChange(_change: FileChange): Promise<null> { return null; }
  async scorePrompt(_prompt: string): Promise<null> { return null; }
}
