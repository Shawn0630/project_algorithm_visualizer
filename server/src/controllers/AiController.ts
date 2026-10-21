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
// LLM_API_KEY, LLM_MODEL. Without them the endpoint answers 503 so the
// UI can say exactly what is missing instead of failing obscurely.

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

function parseReply(content: string): { code: string, explanation: string } {
  const trimmed = content.trim();
  const attempts = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed.code === 'string') {
        return {code: parsed.code, explanation: typeof parsed.explanation === 'string' ? parsed.explanation : ''};
      }
    } catch (error) {
      // try the next shape
    }
  }
  // The model ignored the JSON contract; treat the whole reply as code.
  return {code: trimmed, explanation: ''};
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
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env['LLM_API' + '_KEY'];
    const model = process.env.LLM_MODEL;
    const startedAt = Date.now();
    const logCall = (partial: object) => appendAiCall({
      ts: new Date().toISOString(),
      status: 'ok',
      model: model || null,
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
    const callModel = async (messages: object[]) => {
      const {data} = await axios.post(`${baseUrl!.replace(/\/$/, '')}/chat/completions`, {
        model,
        temperature: 0.2,
        messages,
      }, {
        headers: {Authorization: `Bearer ${apiKey}`},
        timeout: 90000,
      });
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return typeof content === 'string' ? content : null;
    };
    try {
      const messages: object[] = [
        {role: 'system', content: systemPrompt(String(language || 'js'))},
        ...(contextNote ? [{role: 'system', content: contextNote}] : []),
        ...turns,
        {role: 'user', content: `Instruction:\n${instruction}\n\nCurrent file (authoritative):\n${code}`},
      ];
      let content = await callModel(messages);
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
        ]);
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
      const upstream = error && error.response && error.response.data && error.response.data.error && error.response.data.error.message;
      const message = `LLM call failed: ${upstream || (error && error.message) || 'unknown error'}`;
      logCall({status: 'error', error: message});
      return res.status(502).json({message});
    }
  };
}
