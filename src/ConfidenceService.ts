import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ConfidenceResult, FileChange, PromptScore } from './types';
import { rawDiffText } from './TokenEstimator';

export class ClaudeConfidenceProvider implements AIProvider {
  readonly name = 'claude';

  private _client: Anthropic | null = null;
  private readonly _cache = new Map<string, ConfidenceResult>();
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  isConfigured(): boolean {
    const key = vscode.workspace.getConfiguration('gofi').get<string>('anthropicApiKey', '');
    return key.length > 0 || !!process.env.ANTHROPIC_API_KEY;
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
    if (!this.isConfigured()) { return null; }

    const diffText = rawDiffText(change.hunks);
    if (!diffText.trim()) { return null; }

    try {
      const client = this._getClient();
      if (!client) { return null; }

      const t0 = Date.now();
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: 'You are a code review assistant. Respond with only a JSON object, no markdown.',
        messages: [{
          role: 'user',
          content: `Analyze this code diff for the file "${change.relPath}" and respond with ONLY this JSON:\n{"correctness":0-100,"quality":0-100,"rationale":"one sentence"}\n\nDiff:\n${diffText.slice(0, 4000)}`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
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

  private _getClient(): Anthropic | null {
    const key = vscode.workspace.getConfiguration('gofi').get<string>('anthropicApiKey', '')
      || process.env.ANTHROPIC_API_KEY || '';
    if (!key) { return null; }
    if (!this._client) {
      this._client = new Anthropic({ apiKey: key });
    }
    return this._client;
  }

  async scorePrompt(prompt: string): Promise<PromptScore | null> {
    if (!this.isConfigured()) { return null; }

    try {
      const client = this._getClient();
      if (!client) { return null; }

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'You are a code planning assistant. Analyze AI coding prompts and respond with ONLY a JSON object, no markdown.',
        messages: [{
          role: 'user',
          content: `Analyze this prompt that will be sent to an AI coding assistant.\nRespond with ONLY: {"clarity":0-100,"completeness":0-100,"issues":["issue1","issue2"]}\n\nPrompt:\n${prompt.slice(0, 6000)}`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
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
