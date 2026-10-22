import express from 'express';
import axios from 'axios';
import { Controller } from 'controllers/Controller';
import { appendAiCall } from 'utils/aiCallLog';
import { checkSyntax } from 'utils/syntaxCheck';
import { tracerReference } from 'utils/tracerDocs';
import { dryRunVisualization } from 'utils/dryRun';
import { validateApiUsage } from 'utils/apiSurface';
import { fetchLlmModels } from 'utils/llmModels';
import Server from 'Server';

// AI coding assistant for the editor ("coding pad"). The frontend sends
// the current file and an instruction; the server makes ONE
// chat-completions call to the configured OpenAI-compatible endpoint
// and returns the complete revised file plus a short explanation.
// Configuration lives in server/.env and is never shipped to the
// frontend: LLM_BASE_URL (e.g. Gemini's OpenAI-compatible endpoint),
// LLM_API_KEY, LLM_MODEL; LLM_TIMEOUT_MS optionally overrides the
// per-call timeout (default 180s), and LLM_MODEL_FALLBACK names a
// second model (e.g. the lite variant) that takes over automatically
// when the primary stays overloaded / unreachable. Without the
// required ones the endpoint answers 503 so the UI can say exactly
// what is missing instead of failing obscurely.

function systemPrompt(ext: string) {
  return [
    'You are the coding assistant inside Algorithm Visualizer, an app that animates algorithms from code.',
    'You receive one source file and an instruction. Do the work and answer with ONLY a JSON object:',
    '{"code": "<the COMPLETE revised file content>", "explanation": "<short explanation in English>"}',
    'Every reply ALWAYS carries both parts: the natural-language explanation AND the complete source code of the file after your changes, written in the same language as the input file. The UI renders a diff from your code against the current file, so completeness is a hard requirement, not a style preference.',
    'Rules:',
    '- code must be the entire file, ready to replace the old one - never a diff, never a snippet, never wrapped in markdown fences (the JSON carries it).',
    '- NEVER elide anything: no "// ...", no "# ... rest unchanged", no 其余代码不变 / 保持不变 / 同上， no placeholders of any kind. Regions you do not change must be reproduced character-for-character, however long the file is.',
    '- Keep the file\'s existing boilerplate and section markers (// import visualization libraries { ... // }, // define tracer variables { ... // }, // visualize { ... // }) and its overall structure; change only what the instruction needs.',
    '- DEFAULT STANCE: the file you return must be in a state that actually visualizes when the user presses Build. If the file already has tracers, keep them working and extend them to cover the logic you add or change. If the file only defines a class or functions (e.g. a LeetCode class Solution pad) and the instruction has you write or fix algorithm code, ALSO append the driver section from the reference below (create the tracers, one Layout setRoot, a concrete example call, LogTracer narration, delay before and after) - a bare class produces no visualization, which the user reads as a broken answer. Skip the driver ONLY when the user explicitly asks for plain code without visualization, or when the reply is explanation-only (code unchanged).',
    '- The ONLY visualization library is algorithm_visualizer, exactly as documented below. There is no py_viz module and there are no set_variables / mark_line methods - never invent imports or tracer methods. If the file only defines a class or functions (e.g. class Solution), append a driver section that creates the tracers and actually calls the code, or nothing will visualize.',
    '- If the instruction only asks for an explanation, return the code unchanged and put the explanation in the explanation field.',
    '- If the instruction asks for test cases (or supplying cases is the natural fulfilment of it), ALSO include "testCases": [{"name": "<short name>", "args": [<call arguments as JSON, in order>], "expected": <return value as JSON>}] and "entry": "<bare name of the function, or of the method on class Solution, the cases call - e.g. search, not Solution.search>". args/expected must be plain JSON values, and expected must be the value a CORRECT implementation returns - work each case out carefully. Still return the complete code as well (unchanged, unless the instruction also asked for code changes).',
    '- This is a continuing session for one code pad: earlier turns are included as conversation history. The file content in the latest user message is authoritative - the user may have hand-edited it, or accepted or rejected your earlier proposals.',
    '',
    tracerReference(ext),
  ].join('\n');
}

// Detects a "hallucinated library" reply: models occasionally
// invent a visualization module (py_viz) or tracer methods
// (set_variables, mark_line) that do not exist in this app, and the
// resulting code can never run. Returns a label for what was
// invented, or null when the code sticks to the real API.
const HALLUCINATED_LIB_PATTERNS: [RegExp, string][] = [
  [/py_viz/, 'the non-existent module "py_viz"'],
  [/\.set_variables\s*\(/, 'the invented tracer method "set_variables"'],
  [/\.mark_line\s*\(/, 'the invented tracer method "mark_line"'],
  [/\bimport\s+visualizer\b|\bfrom\s+visualizer\s+import/, 'the non-existent module "visualizer" (the real one is "algorithm_visualizer")'],
];

export function findHallucinatedLib(code: string): string | null {
  for (const [pattern, label] of HALLUCINATED_LIB_PATTERNS) {
    if (pattern.test(code)) return label;
  }
  return null;
}

// Detects a "lazy" reply: the model was told to return the complete
// file, but models still elide unchanged regions with comments like
// "// ... 其余不变" - and the diff UI would then read the elided part
// as deleted code. Two signals: elision markers in comments, and a
// suspicious length collapse versus the original file.
const ELISION_WORDS = /(rest|remaining|unchanged|omitted|same as before|其余|剩余|未改|不变|省略|同上|略过|保持原样)/i;

export function looksElided(code: string, original: string): boolean {
  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    // A line that is only an ellipsis comment: // ... / # ... / /* ... */
    if (/^(\/\/|#|\/\*)\s*(\.\.\.|…)+\s*(\*\/)?$/.test(trimmed)) return true;
    // A comment carrying both an ellipsis and an elision word.
    const commentAt = Math.max(trimmed.indexOf('//'), trimmed.indexOf('#'), trimmed.indexOf('/*'));
    if (commentAt >= 0) {
      const comment = trimmed.slice(commentAt);
      if (/(\.\.\.|…)/.test(comment) && ELISION_WORDS.test(comment)) return true;
    }
  }
  if (original.length > 400 && code.length < original.length * 0.45) return true;
  return false;
}

// Strip one wrapping markdown fence from a code string, if present.
// The capture is lazy and keeps the content byte-exact, including a
// trailing newline that belongs to the code itself.
function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)```$/);
  return match ? match[1] : text;
}

// The first balanced {...} region at or after `from`, honouring
// string literals and escapes - so prose braces around a JSON
// payload do not poison the extraction.
function balancedJson(text: string, from: number): string | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asReply(parsed: any): { code: string, explanation: string, testCases?: { name: string, args: any[], expected: any }[], entry?: string } | null {
  if (parsed && typeof parsed.code === 'string') {
    const reply: { code: string, explanation: string, testCases?: { name: string, args: any[], expected: any }[], entry?: string } = {
      code: stripFence(parsed.code),
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    };
    // A reply may also carry a set of test cases (the third kind of
    // AI result, next to code and plain explanation): the UI offers
    // them as an apply-into-the-Testcase-panel action.
    const testCases = validCases(parsed.testCases);
    if (testCases) {
      reply.testCases = testCases;
      if (typeof parsed.entry === 'string' && parsed.entry.trim()) reply.entry = parsed.entry.trim();
    }
    return reply;
  }
  return null;
}

export function parseReply(content: string): { code: string, explanation: string, testCases?: { name: string, args: any[], expected: any }[], entry?: string } {
  const trimmed = content.trim();
  // 1. JSON, wherever it lives: the whole reply, inside a fence, or
  // as a balanced {...} region surrounded by prose. Models keep
  // adding "Here is the code:" / "Hope this helps" around the
  // payload; the previous first-{-to-last-} slice and the raw-text
  // fallback then leaked that prose into the code pad.
  const candidates: string[] = [trimmed];
  const jsonFence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (jsonFence) candidates.push(jsonFence[1]);
  let searchFrom = 0;
  for (let i = 0; i < 5; i += 1) {
    const region = balancedJson(trimmed, searchFrom);
    if (!region) break;
    candidates.push(region);
    const next = trimmed.indexOf('{', searchFrom + 1);
    if (next < 0) break;
    searchFrom = next;
  }
  for (const candidate of candidates) {
    try {
      const reply = asReply(JSON.parse(candidate));
      if (reply) return reply;
    } catch (error) {
      // try the next shape
    }
  }
  // 2. A fenced code block without JSON: the block is the code, the
  // prose around it is the explanation.
  const codeFence = trimmed.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/);
  if (codeFence) {
    return {code: codeFence[1], explanation: trimmed.replace(codeFence[0], '').trim()};
  }
  // 3. Raw code with no packaging at all: hand it back untouched
  // (a wrapping fence, if that is all the packaging there is, still
  // comes off via the candidates above / stripFence here).
  const fenced = stripFence(trimmed);
  return {code: fenced !== trimmed ? fenced : content, explanation: ''};
}

// One chat-completions call chain with the same patience policy as
// the assistant (overload retries with backoff + Retry-After, one
// timeout retry, automatic switch to LLM_MODEL_FALLBACK when the
// primary stays overloaded). Used by the test-case generator and the
// admin console's LeetCode import. The assistant keeps its own
// inline chain for now. Throws an Error carrying .status (503
// unconfigured / 502 upstream) and a composed .message in the same
// style the assistant returns.
export async function callLlm(messages: object[], requestedModel: string | null): Promise<{ content: string, usedModel: string, totalAttempts: number }> {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env['LLM_API' + '_KEY'];
  const primaryModel = requestedModel || process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !primaryModel) {
    const error: any = new Error('The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in server/.env, then restart the server.');
    error.status = 503;
    throw error;
  }
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 180000;
  const FAST_DELAYS = [2000, 5000, 10000];
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let totalAttempts = 0;
  let usedModel: string = primaryModel;
  const isRetryableFailure = (error: any) => {
    const status = error && error.response && error.response.status;
    return !!(error && ((error as any).llmTimeout || !status || status === 429 || status >= 500));
  };
  const callModel = async (modelName: string): Promise<string | null> => {
    let fastRetries = 0;
    let timeoutRetries = 0;
    for (;;) {
      totalAttempts += 1;
      try {
        const {data} = await axios.post(`${baseUrl!.replace(/\/$/, '')}/chat/completions`, {
          model: modelName,
          temperature: 0.2,
          messages,
        }, {
          headers: {Authorization: `Bearer ${apiKey}`},
          timeout: timeoutMs,
        });
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return typeof content === 'string' ? content : null;
      } catch (error) {
        const status = error && error.response && error.response.status;
        const isTimeout = !!(error && (error.code === 'ECONNABORTED' || /timeout/i.test(String(error.message || ''))));
        if (isTimeout) {
          if (timeoutRetries >= 1) {
            const timeoutError: any = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s - the provider may be overloaded; try again, or use a lighter model`);
            timeoutError.llmTimeout = true;
            throw timeoutError;
          }
          timeoutRetries += 1;
          await sleep(1000);
        } else if (!status || status === 429 || status >= 500) {
          if (fastRetries >= FAST_DELAYS.length) throw error;
          const retryAfterSec = Number(error && error.response && error.response.headers && error.response.headers['retry-after']);
          const retryAfterMs = isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
          const delay = Math.min(30000, Math.max(FAST_DELAYS[fastRetries], retryAfterMs));
          fastRetries += 1;
          await sleep(delay);
        } else {
          throw error;
        }
      }
    }
  };
  try {
    let content: string | null;
    try {
      content = await callModel(primaryModel!);
    } catch (error) {
      const fallbackModel = process.env.LLM_MODEL_FALLBACK;
      if (fallbackModel && fallbackModel !== primaryModel && isRetryableFailure(error)) {
        usedModel = fallbackModel;
        content = await callModel(fallbackModel);
      } else {
        throw error;
      }
    }
    if (content === null) {
      const error: any = new Error('The LLM returned an unrecognized response.');
      error.status = 502;
      throw error;
    }
    return {content, usedModel, totalAttempts};
  } catch (error) {
    const status = error && error.response && error.response.status;
    const data = error && error.response && error.response.data;
    const upstream = (data && data.error && data.error.message)
      || (data && typeof data.message === 'string' && data.message)
      || (status === 503 ? 'the provider reports the model is overloaded (503, high demand)' : null);
    const hint = status === 404
      ? ` - model "${usedModel}" was not found (404): the id is wrong or unavailable to this API key; Admin -> AI Call Log -> "List models my key can use" shows the exact ids`
      : '';
    const wrapped: any = new Error(`LLM call failed: ${upstream || (error && error.message) || 'unknown error'}${hint}${totalAttempts > 1 ? ` (after ${totalAttempts} attempts)` : ''}`);
    wrapped.status = (error && error.status) || 502;
    wrapped.totalAttempts = totalAttempts;
    wrapped.usedModel = usedModel;
    throw wrapped;
  }
}

// Validates a raw cases array from a model reply: every case
// needs an args array; names are defaulted, everything is capped.
// Returns null when nothing usable remains.
function validCases(raw: any): { name: string, args: any[], expected: any }[] | null {
  if (!Array.isArray(raw)) return null;
  const cases = raw
    .filter((tc: any) => tc && Array.isArray(tc.args))
    .slice(0, 12)
    .map((tc: any, i: number) => ({
      name: typeof tc.name === 'string' && tc.name.trim() ? tc.name.trim().slice(0, 60) : `Case ${i + 1}`,
      args: tc.args,
      expected: tc.expected === undefined ? null : tc.expected,
    }));
  return cases.length ? cases : null;
}

// Extracts and validates the generator's JSON payload from a model
// reply (the JSON may sit inside fences or prose, like the
// assistant's replies). Returns null when nothing usable is found.
function parseGeneratedCases(content: string): { entry: string, cases: { name: string, args: any[], expected: any }[] } | null {
  const candidates: string[] = [content.trim()];
  const jsonFence = content.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (jsonFence) candidates.push(jsonFence[1]);
  let searchFrom = 0;
  for (let i = 0; i < 5; i += 1) {
    const region = balancedJson(content, searchFrom);
    if (!region) break;
    candidates.push(region);
    const next = content.indexOf('{', searchFrom + 1);
    if (next < 0) break;
    searchFrom = next;
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed) continue;
      const cases = validCases(parsed.cases);
      if (!cases) continue;
      return {entry: typeof parsed.entry === 'string' ? parsed.entry.trim() : '', cases};
    } catch (error) {
      // try the next shape
    }
  }
  return null;
}

// Parses one test-chat reply: a JSON object with a message, and -
// when the reply changes the case list - a mode ("append" = cases
// holds only new ones, "replace" = cases holds the complete
// revised list) plus the cases themselves. Returns null when the
// reply carries no usable JSON message (the handler then delivers
// the raw text as a plain message with no case change).
function parseTestChatReply(content: string): { message: string, entry: string, mode: 'append' | 'replace', cases: { name: string, args: any[], expected: any }[] | null } | null {
  const candidates: string[] = [content.trim()];
  const jsonFence = content.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (jsonFence) candidates.push(jsonFence[1]);
  let searchFrom = 0;
  for (let i = 0; i < 5; i += 1) {
    const region = balancedJson(content, searchFrom);
    if (!region) break;
    candidates.push(region);
    const next = content.indexOf('{', searchFrom + 1);
    if (next < 0) break;
    searchFrom = next;
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed.message !== 'string' || !parsed.message.trim()) continue;
      return {
        message: parsed.message.trim().slice(0, 8000),
        entry: typeof parsed.entry === 'string' ? parsed.entry.trim() : '',
        mode: parsed.mode === 'replace' ? 'replace' : 'append',
        cases: validCases(parsed.cases),
      };
    } catch (error) {
      // try the next shape
    }
  }
  return null;
}

export class AiController extends Controller {  constructor(server: Server) {
    super(server);
    this.router.post('/assist', this.assist);
    this.router.post('/generate-tests', this.generateTests);
    this.router.post('/test-chat', this.testChat);
    this.router.get('/models', this.models);
  }

  route = (router: express.Router): void => {
    router.use('/ai', this.router);
  };

  // The models the configured key can use, for the assistant's model
  // picker (see utils/llmModels).
  models = async (req: express.Request, res: express.Response) => {
    try {
      const result = await fetchLlmModels();
      if (!result) {
        return res.status(503).json({message: 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in server/.env, then restart the server.'});
      }
      return res.json(result);
    } catch (error) {
      const upstream = error && error.response && error.response.data && error.response.data.error && error.response.data.error.message;
      return res.status(502).json({message: `Listing models failed: ${upstream || (error && error.message) || 'unknown error'}`});
    }
  };

  // AI test-case generation for the Testcase panel: the frontend
  // sends the pad's current code (plus the problem statement when
  // the page has one), and the model returns entry + cases with
  // args and expected values as plain JSON, ready to drop into the
  // panel's case list.
  generateTests = async (req: express.Request, res: express.Response) => {
    const {code, language, entry, context} = (req.body || {}) as any;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({message: 'Missing code in the request.'});
    }
    const countRaw = Number((req.body as any).count);
    const count = isFinite(countRaw) ? Math.max(1, Math.min(12, Math.round(countRaw))) : 6;
    const requestedModel = typeof (req.body as any).model === 'string' && (req.body as any).model.trim()
      ? (req.body as any).model.trim().slice(0, 200)
      : null;
    const startedAt = Date.now();
    let sentMessages: any = null;
    const logCall = (partial: object) => appendAiCall({
      ts: new Date().toISOString(),
      status: 'ok',
      model: requestedModel || process.env.LLM_MODEL || null,
      attempts: 0,
      language: String(language || 'js'),
      instruction: 'generate-tests',
      context: null,
      history: [],
      messages: sentMessages,
      code,
      rawResponse: null,
      reply: null,
      syntax: null,
      error: null,
      ...partial,
      durationMs: Date.now() - startedAt,
    } as any);
    const messages: object[] = [
      {
        role: 'system',
        content: [
          'You generate test cases for a coding problem inside Algorithm Visualizer.',
          'Reply with ONLY a JSON object - no prose, no markdown fences:',
          '{"entry": "<bare name of the function, or of the method on class Solution, to call - e.g. search, not Solution.search>", "cases": [{"name": "<short case name>", "args": [<the call arguments as JSON, in order>], "expected": <the return value as JSON>}]}',
          'Rules:',
          '- args and expected must be plain JSON values only (numbers, strings, booleans, null, arrays, objects): the runner passes args as JSON and compares the return value against expected as JSON.',
          '- expected must be the value a CORRECT implementation returns for those args. Work every case out carefully - a wrong expected value is worse than no case.',
          '- Cover, in order: the examples from the problem statement (when one is provided), then typical cases, then edge cases that fit this problem (empty or minimal input, a single element, duplicates, already-ordered and reverse-ordered input, zero / negative values, a larger input).',
          '- Keep numbers exact; never use floating-point approximations.',
          `- Generate exactly ${count} cases unless the problem genuinely supports fewer.`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Language: ${String(language || 'js')}`,
          `Entry (if already known): ${typeof entry === 'string' && entry.trim() ? entry.trim() : '(infer it from the code)'}`,
          '',
          'Problem statement:',
          typeof context === 'string' && context.trim() ? context.slice(0, 8000) : '(not provided - infer the problem from the code)',
          '',
          'Current code (the implementation under test - infer the entry signature and the semantics from it):',
          code.slice(0, 20000),
        ].join('\n'),
      },
    ];
    try {
      sentMessages = messages;
      sentMessages = messages;
      const {content, usedModel, totalAttempts} = await callLlm(messages, requestedModel);
      const parsed = parseGeneratedCases(content);
      if (!parsed) {
        logCall({status: 'error', model: usedModel, attempts: totalAttempts, rawResponse: content, error: 'The model did not return usable test cases.'});
        return res.status(502).json({message: 'The model did not return usable test cases - try again, or pick a different model in the AI Assistant.'});
      }
      const finalEntry = parsed.entry || (typeof entry === 'string' ? entry.trim() : '');
      logCall({model: usedModel, attempts: totalAttempts, rawResponse: content, reply: {entry: finalEntry, cases: parsed.cases} as any});
      return res.json({entry: finalEntry, cases: parsed.cases, model: usedModel});
    } catch (error) {
      const status = (error as any).status || 502;
      logCall({
        status: status === 503 ? 'not_configured' : 'error',
        model: (error as any).usedModel || requestedModel || process.env.LLM_MODEL || null,
        attempts: (error as any).totalAttempts || 0,
        error: (error as Error).message,
      });
      return res.status(status).json({message: (error as Error).message});
    }
  };

  // One turn of the Testcase panel's dedicated test-case
  // generation session: a conversation scoped to generating and
  // refining THIS pad's cases, where the user can follow up
  // ("add an empty-string case", "make case 2 harder", "drop the
  // duplicate"). The client sends the pad's code, the problem
  // statement, the CURRENT case list and the chat history every
  // turn, so follow-ups always operate on the real list. The model
  // answers with a JSON object: a message, plus - when it changes
  // the cases - either mode "append" with only the new cases, or
  // mode "replace" with the complete revised list. A reply that
  // does not parse as that JSON is still delivered as a plain
  // message with no case change.
  testChat = async (req: express.Request, res: express.Response) => {
    const { code, language, entry, context, instruction, currentCases } = (req.body || {}) as any;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ message: 'Missing code in the request.' });
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ message: 'Missing instruction in the request.' });
    }
    const turns: { role: string, content: string }[] = Array.isArray((req.body as any).history)
      ? (req.body as any).history
        .filter((turn: any) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
        .slice(-20)
        .map((turn: any) => ({ role: turn.role, content: turn.content.slice(0, 8000) }))
      : [];
    const requestedModel = typeof (req.body as any).model === 'string' && (req.body as any).model.trim()
      ? (req.body as any).model.trim().slice(0, 200)
      : null;
    const startedAt = Date.now();
    let sentMessages: any = null;
    const logCall = (partial: object) => appendAiCall({
      ts: new Date().toISOString(),
      status: 'ok',
      model: requestedModel || process.env.LLM_MODEL || null,
      attempts: 0,
      language: String(language || 'js'),
      instruction: 'test-chat',
      context: null,
      history: turns,
      messages: sentMessages,
      code,
      rawResponse: null,
      reply: null,
      syntax: null,
      error: null,
      ...partial,
      durationMs: Date.now() - startedAt,
    } as any);
    const currentList = Array.isArray(currentCases) && currentCases.length
      ? JSON.stringify(currentCases.slice(0, 50), null, 1).slice(0, 12000)
      : '(the case list is currently empty)';
    const messages: object[] = [
      {
        role: 'system',
        content: [
          'You are the dedicated test-case generation session for one coding problem inside Algorithm Visualizer. Your ONLY job is this pad\'s test cases: generating them, adding to them, refining them, and answering questions about them.',
          'Reply with ONLY a JSON object - no prose outside it, no markdown fences:',
          '{"message": "<your reply to the user, in the language the user writes in>", "entry": "<entry name - include when you state or change it>", "mode": "append" | "replace", "cases": [{"name": "...", "args": [...], "expected": ...}]}',
          'Rules:',
          '- Include "cases" ONLY when you are changing the case list in this reply. For a pure question or explanation, omit "cases" (and "mode").',
          '- mode "append": the user asked to ADD cases - "cases" holds ONLY the new ones.',
          '- mode "replace": the user asked to change, fix or remove existing cases - "cases" holds the COMPLETE revised list.',
          '- args and expected must be plain JSON values only (numbers, strings, booleans, null, arrays, objects): the runner passes args as JSON and compares the return value against expected as JSON.',
          '- expected must be the value a CORRECT implementation returns for those args. Work every case out carefully - a wrong expected value is worse than no case.',
          '- Keep numbers exact; never use floating-point approximations.',
          '- The current case list is given in the first user message and is the source of truth for what exists; refer to cases by their names when you talk about them.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Language: ${String(language || 'js')}`,
          `Entry (if already known): ${typeof entry === 'string' && entry.trim() ? entry.trim() : '(infer it from the code)'}`,
          '',
          'Problem statement:',
          typeof context === 'string' && context.trim() ? context.slice(0, 8000) : '(not provided - infer the problem from the code)',
          '',
          'Current code (the implementation under test):',
          code.slice(0, 20000),
          '',
          'Current test cases (JSON):',
          currentList,
        ].join('\n'),
      },
      ...turns,
      { role: 'user', content: instruction.trim().slice(0, 8000) },
    ];
    try {
      const { content, usedModel, totalAttempts } = await callLlm(messages, requestedModel);
      const parsed = parseTestChatReply(content);
      const reply = parsed || { message: stripFence(content).trim() || '(empty reply)', entry: '', mode: 'append' as const, cases: null };
      const finalEntry = reply.entry || (typeof entry === 'string' ? entry.trim() : '');
      logCall({ model: usedModel, attempts: totalAttempts, rawResponse: content, reply: { ...reply, entry: finalEntry } as any });
      return res.json({ message: reply.message, entry: finalEntry, mode: reply.mode, cases: reply.cases, model: usedModel });
    } catch (error) {
      const status = (error as any).status || 502;
      logCall({
        status: status === 503 ? 'not_configured' : 'error',
        model: (error as any).usedModel || requestedModel || process.env.LLM_MODEL || null,
        attempts: (error as any).totalAttempts || 0,
        error: (error as Error).message,
      });
      return res.status(status).json({ message: (error as Error).message });
    }
  };

  assist = async (req: express.Request, res: express.Response) => {
    const {code, language, instruction, history, context} = req.body;
    if (typeof code !== 'string' || typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({message: 'Missing code or instruction in the request.'});
    }
    // Conversation history of this pad's session, oldest first. Bounded
    // so a long session cannot grow the request without limit.
    const turns: { role: string, content: string }[] = Array.isArray(history)
      ? history.filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
        .slice(-20)
        .map(turn => ({role: turn.role, content: turn.content.slice(0, 12000)}))
      : [];
    const contextNote = context && typeof context === 'object'
      ? [
        `Current window: page "${String(context.title || '')}", file "${String(context.fileName || '')}".`,
        Array.isArray(context.files) && context.files.length
          ? `Files in this page: ${context.files.map((name: any) => String(name)).join(', ')}.`
          : '',
      ].filter(Boolean).join(' ')
      : '';
    // The page's Markdown document (problem statement), when the
    // frontend sends one: a separate context message, length-capped.
    const readme = context && typeof context === 'object' && context.readme && typeof context.readme === 'object'
      ? {
        name: String(context.readme.name || 'README.md'),
        content: String(context.readme.content || '').slice(0, 12000),
      }
      : null;
    const readmeNote = readme && readme.content.trim()
      ? `Page document (${readme.name}) - the problem statement / description for this page. Treat it as context for what the code on this page is supposed to do:\n\n${readme.content}`
      : '';
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env['LLM_API' + '_KEY'];
    const model = process.env.LLM_MODEL;
    // The model picker in the assistant can choose the model per
    // request; it wins over the .env default for that call. The env
    // fallback model still applies underneath either choice.
    const requestedModel = typeof (req.body as any).model === 'string' && (req.body as any).model.trim()
      ? (req.body as any).model.trim().slice(0, 200)
      : null;
    const primaryModel = requestedModel || model;
    const startedAt = Date.now();
    let usedModel: string | null = primaryModel || null;
    let totalAttempts = 0;
    let lastSentMessages: any = null;
    const logCall = (partial: object) => appendAiCall({
      ts: new Date().toISOString(),
      status: 'ok',
      model: usedModel,
      attempts: totalAttempts,
      language: String(language || 'js'),
      instruction,
      context: context || null,
      history: turns,
      messages: lastSentMessages,
      code,
      rawResponse: null,
      reply: null,
      syntax: null,
      error: null,
      ...partial,
      durationMs: Date.now() - startedAt,
    } as any);
    if (!baseUrl || !apiKey || !primaryModel) {
      logCall({status: 'not_configured'});
      return res.status(503).json({
        message: 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in server/.env, then restart the server.',
      });
    }
    // One provider call chain for one model, with retries. Overload
    // failures (429 / 5xx / network) retry with a patient backoff -
    // 2s, 5s, 10s, honouring Retry-After - because a Gemini 503
    // "high demand" window usually outlasts a quick retry or two.
    // A timeout has already burned the whole timeout budget, so it
    // earns a single retry. The timeout is generous because thinking
    // models can be slow to first token; tune with LLM_TIMEOUT_MS.
    const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 180000;
    const FAST_DELAYS = [2000, 5000, 10000];
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const isRetryableFailure = (error: any) => {
      const status = error && error.response && error.response.status;
      return !!(error && ((error as any).llmTimeout || !status || status === 429 || status >= 500));
    };
    const callModel = async (messages: object[], modelName: string) => {
      lastSentMessages = messages;
      let fastRetries = 0;
      let timeoutRetries = 0;
      for (;;) {
        totalAttempts += 1;
        try {
          const {data} = await axios.post(`${baseUrl!.replace(/\/$/, '')}/chat/completions`, {
            model: modelName,
            temperature: 0.2,
            messages,
          }, {
            headers: {Authorization: `Bearer ${apiKey}`},
            timeout: timeoutMs,
          });
          const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          return typeof content === 'string' ? content : null;
        } catch (error) {
          const status = error && error.response && error.response.status;
          const isTimeout = !!(error && (error.code === 'ECONNABORTED' || /timeout/i.test(String(error.message || ''))));
          if (isTimeout) {
            if (timeoutRetries >= 1) {
              const timeoutError = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s - the provider may be overloaded; try again, or use a lighter model`);
              (timeoutError as any).llmTimeout = true;
              throw timeoutError;
            }
            timeoutRetries += 1;
            await sleep(1000);
          } else if (!status || status === 429 || status >= 500) {
            if (fastRetries >= FAST_DELAYS.length) throw error;
            const retryAfterSec = Number(error && error.response && error.response.headers && error.response.headers['retry-after']);
            const retryAfterMs = isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
            const delay = Math.min(30000, Math.max(FAST_DELAYS[fastRetries], retryAfterMs));
            fastRetries += 1;
            await sleep(delay);
          } else {
            throw error;
          }
        }
      }
    };
    try {
      const messages: object[] = [
        {role: 'system', content: systemPrompt(String(language || 'js'))},
        ...(contextNote ? [{role: 'system', content: contextNote}] : []),
        ...(readmeNote ? [{role: 'system', content: readmeNote}] : []),
        ...turns,
        {role: 'user', content: `Instruction:\n${instruction}\n\nCurrent file (authoritative):\n${code}`},
      ];
      // Primary model first; if it stays overloaded / unreachable
      // through its whole retry chain and a fallback model is
      // configured (LLM_MODEL_FALLBACK, e.g. the lite variant), the
      // fallback takes over instead of failing the request.
      const fallbackModel = process.env.LLM_MODEL_FALLBACK;
      let content: string | null;
      try {
        content = await callModel(messages, primaryModel!);
      } catch (error) {
        if (fallbackModel && fallbackModel !== primaryModel && isRetryableFailure(error)) {
          usedModel = fallbackModel;
          content = await callModel(messages, fallbackModel);
        } else {
          throw error;
        }
      }
      if (content === null) {
        logCall({status: 'error', error: 'The LLM returned an unrecognized response.'});
        return res.status(502).json({message: 'The LLM returned an unrecognized response.'});
      }
      let reply = parseReply(content);
      // Completeness enforcement: if the reply looks elided (the diff
      // UI would treat missing regions as deletions), demand the full
      // file once more. If it still looks elided, hand it over with
      // the suspicion flagged instead of silently trusting it.
      let elidedFirstAttempt: string | null = null;
      let partialSuspected = reply.code !== code && looksElided(reply.code, code);
      if (partialSuspected) {
        elidedFirstAttempt = content;
        const retryContent = await callModel([
          ...messages,
          {role: 'assistant', content},
          {
            role: 'user',
            content: 'Your previous reply was incomplete: it contained elisions, or was much shorter than the original file. Return the COMPLETE revised file once more - reproduce every unchanged line verbatim, with no elision, abbreviation or placeholder comments of any kind. Reply with the same JSON format only.',
          },
        ], usedModel || primaryModel!);
        if (retryContent !== null) {
          const retryReply = parseReply(retryContent);
          content = retryContent;
          reply = retryReply;
          partialSuspected = reply.code !== code && looksElided(reply.code, code);
        }
      }
      let changed = reply.code !== code;
      // Hallucinated-library guard: if the proposal imports or
      // calls a visualization API that does not exist in this app
      // (py_viz, set_variables, mark_line, ...), demand a rewrite
      // against the real algorithm_visualizer API once. If it
      // persists, flag it on the explanation rather than handing
      // over code that can never run without a word.
      let hallucinatedLib = changed ? findHallucinatedLib(reply.code) : null;
      if (hallucinatedLib) {
        const retryContent = await callModel([
          ...messages,
          {role: 'assistant', content},
          {
            role: 'user',
            content: `Your previous reply used ${hallucinatedLib}, which does not exist in this app. The ONLY visualization library is algorithm_visualizer, with exactly the API in the reference - and if the file only defines a class or functions, you must append a driver section that creates the tracers, sets the layout root and calls the code. Rewrite the COMPLETE file using only the real API. Reply with the same JSON format only.`,
          },
        ], usedModel || primaryModel!);
        if (retryContent !== null) {
          const retryReply = parseReply(retryContent);
          content = retryContent;
          reply = retryReply;
          hallucinatedLib = findHallucinatedLib(reply.code);
        }
        if (hallucinatedLib) {
          reply = {
            ...reply,
            explanation: `Warning: the model used ${hallucinatedLib}, which does not exist in this app - this code will not run as-is. ${reply.explanation}`,
          };
        }
      }
      // Static API-surface validation: the tracer reference is in
      // the prompt, yet models still misuse it in ways that
      // compile and run - Array2DTracer's 4-argument select on an
      // Array1DTracer, an invented method, a duplicated import.
      // Every tracer call in the proposal is checked against the
      // real library surface (parsed from the library sources);
      // violations get one repair round quoting exactly what is
      // wrong, and anything left over rides along as apiError so
      // the UI can show it with a fix-it action.
      let apiError: string | null = null;
      const dryRunLanguage = String(language || 'js');
      if (changed && ['py', 'js', 'java'].includes(dryRunLanguage)) {
        let violations = await validateApiUsage(dryRunLanguage, reply.code);
        if (violations.length) {
          const retryContent = await callModel([
            ...messages,
            {role: 'assistant', content},
            {
              role: 'user',
              content: `Your code misuses this app's tracer library - the API check flagged these problems:\n${violations.map(v => `- ${v}`).join('\n')}\nFix them and return the COMPLETE file again, using only the methods in the reference, each with the argument count the reference shows for that exact tracer class.`,
            },
          ], usedModel || primaryModel!);
          if (retryContent !== null) {
            const retryReply = parseReply(retryContent);
            content = retryContent;
            reply = retryReply;
            changed = reply.code !== code;
            violations = await validateApiUsage(dryRunLanguage, reply.code);
          }
          if (violations.length) {
            apiError = violations.join('\n');
            reply = {
              ...reply,
              explanation: `Warning: this code misuses the tracer library (see the API check below). ${reply.explanation}`,
            };
          }
        }
      }
      // Dry-run validation: when the proposal uses the tracer
      // library, actually run it (the same machinery a Build uses)
      // before handing it over - a syntax check cannot see a
      // missing driver, an undefined tracer variable or a library
      // that was never imported. One automatic repair round with
      // the real run error as the teacher; if it still fails, the
      // error rides along so the UI can show it and offer the
      // fix-it action.
      let runError: string | null = null;
      // Trigger when either side mentions the visualization
      // library - a pure class/function file on either side of
      // the edit is exactly the "runs but shows nothing" failure.
      // Case-insensitive on purpose: broken AI code often calls a
      // lowercase `tracer` variable that was never defined, and
      // that must still count as visualization code.
      const vizMentioned = /tracer|algorithm_visualizer|layout/i.test(reply.code) || /tracer|algorithm_visualizer|layout/i.test(code);
      if (changed && ['py', 'js', 'java'].includes(dryRunLanguage) && vizMentioned) {
        let run = await dryRunVisualization(dryRunLanguage, reply.code);
        if (!run.ok) {
          const retryContent = await callModel([
            ...messages,
            {role: 'assistant', content},
            {
              role: 'user',
              content: `Your code does not produce a working visualization - running it failed with:\n${run.error}\nFix it and return the COMPLETE file again: import the library (Python: from algorithm_visualizer import *; JavaScript: const { Tracer, Array1DTracer, LogTracer, Layout, VerticalLayout } = require('algorithm-visualizer'); Java: import org.algorithm_visualizer.* and a public class Main with main), define every tracer variable you use, set the layout root exactly once, and if the file only defines a class or functions, append a driver section that creates the tracers and actually calls the code.`,
            },
          ], usedModel || primaryModel!);
          if (retryContent !== null) {
            const retryReply = parseReply(retryContent);
            content = retryContent;
            reply = retryReply;
            changed = reply.code !== code;
            run = await dryRunVisualization(dryRunLanguage, reply.code);
          }
          runError = run.ok ? null : (run.error || 'The visualization run failed.');
          if (runError) {
            reply = {
              ...reply,
              explanation: `Warning: this code was run and does not produce a working visualization yet (see the run error). ${reply.explanation}`,
            };
          }
        }
      }
      // Check the proposal compiles before the user is asked to review
      // it; a broken proposal is labelled, not silently handed over.
      const syntax = changed ? await checkSyntax(String(language || 'js'), reply.code) : null;
      const fullReply = {...reply, changed, partialSuspected, runError: runError || undefined, apiError: apiError || undefined};
      logCall({status: 'ok', rawResponse: content, elidedFirstAttempt, reply: fullReply, syntax});
      return res.json({...fullReply, syntax});
    } catch (error) {
      const status = error && error.response && error.response.status;
      const data = error && error.response && error.response.data;
      const upstream = (data && data.error && data.error.message)
        || (data && typeof data.message === 'string' && data.message)
        || (status === 503 ? 'the provider reports the model is overloaded (503, high demand)' : null);
      const hint = status === 404
        ? ` - model "${usedModel}" was not found (404): the id is wrong or unavailable to this API key; Admin -> AI Call Log -> "List models my key can use" shows the exact ids`
        : '';
      const message = `LLM call failed: ${upstream || (error && error.message) || 'unknown error'}${hint}${totalAttempts > 1 ? ` (after ${totalAttempts} attempts)` : ''}`;
      logCall({status: 'error', error: message});
      return res.status(502).json({message});
    }
  };
}
