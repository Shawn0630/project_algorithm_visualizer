import express from 'express';
import axios from 'axios';
import { Controller } from 'controllers/Controller';
import { appendAiCall } from 'utils/aiCallLog';
import { checkSyntax } from 'utils/syntaxCheck';
import { tracerReference } from 'utils/tracerDocs';
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
    '- When asked to visualize / add tracers: instrument the algorithm with the tracer API below, call delay after each meaningful step, set the root layout once, and keep the algorithm logic itself unchanged.',
    '- If the instruction only asks for an explanation, return the code unchanged and put the explanation in the explanation field.',
    '- This is a continuing session for one code pad: earlier turns are included as conversation history. The file content in the latest user message is authoritative - the user may have hand-edited it, or accepted or rejected your earlier proposals.',
    '',
    tracerReference(ext),
  ].join('\n');
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

function asReply(parsed: any): { code: string, explanation: string } | null {
  if (parsed && typeof parsed.code === 'string') {
    return {
      code: stripFence(parsed.code),
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    };
  }
  return null;
}

export function parseReply(content: string): { code: string, explanation: string } {
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

export class AiController extends Controller {
  constructor(server: Server) {
    super(server);
    this.router.post('/assist', this.assist);
  }

  route = (router: express.Router): void => {
    router.use('/ai', this.router);
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
    const startedAt = Date.now();
    let usedModel: string | null = model || null;
    let totalAttempts = 0;
    const logCall = (partial: object) => appendAiCall({
      ts: new Date().toISOString(),
      status: 'ok',
      model: usedModel,
      attempts: totalAttempts,
      language: String(language || 'js'),
      instruction,
      context: context || null,
      history: turns,
      code,
      rawResponse: null,
      reply: null,
      syntax: null,
      error: null,
      ...partial,
      durationMs: Date.now() - startedAt,
    } as any);
    if (!baseUrl || !apiKey || !model) {
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
        content = await callModel(messages, model!);
      } catch (error) {
        if (fallbackModel && fallbackModel !== model && isRetryableFailure(error)) {
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
        ], usedModel || model!);
        if (retryContent !== null) {
          const retryReply = parseReply(retryContent);
          content = retryContent;
          reply = retryReply;
          partialSuspected = reply.code !== code && looksElided(reply.code, code);
        }
      }
      const changed = reply.code !== code;
      // Check the proposal compiles before the user is asked to review
      // it; a broken proposal is labelled, not silently handed over.
      const syntax = changed ? await checkSyntax(String(language || 'js'), reply.code) : null;
      const fullReply = {...reply, changed, partialSuspected};
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
