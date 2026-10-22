import fs from 'fs';
import path from 'path';
import { rootDir } from 'config/paths';

// Append-only log of AI assistant calls, one JSON object per line, so
// the admin console can show exactly what was sent to the model and
// what came back. Local only: server/data/ is gitignored (entries
// contain the user's code and instructions).
const logFile = path.resolve(rootDir, 'data', 'ai-calls.jsonl');

export interface AiCallEntry {
  ts: string;
  status: 'ok' | 'error' | 'not_configured';
  model: string | null;
  language: string;
  instruction: string;
  context: any;
  history: any;
  code: string;
  rawResponse: string | null;
  reply: { code: string, explanation: string, changed: boolean } | null;
  syntax: { ok: boolean, error: string } | null;
  error: string | null;
  durationMs: number;
}

export function appendAiCall(entry: AiCallEntry): void {
  try {
    fs.mkdirSync(path.dirname(logFile), {recursive: true});
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    // Logging must never break the assistant itself.
    console.error('Failed to write AI call log:', (error as Error).message);
  }
}

export function readAiCalls(limit: number, offset: number = 0): { calls: AiCallEntry[], total: number } {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(line => line.trim());
    const entries: AiCallEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        // skip a corrupt line rather than failing the whole read
      }
    }
    const newestFirst = entries.reverse();
    const safeLimit = Math.max(1, Math.min(limit || 20, 200));
    const safeOffset = Math.max(0, offset || 0);
    return { calls: newestFirst.slice(safeOffset, safeOffset + safeLimit), total: newestFirst.length };
  } catch (error) {
    return { calls: [], total: 0 };
  }
}
