import axios from 'axios';
import express from 'express';
import path from 'path';
import { Controller } from 'controllers/Controller';
import { callLlm } from 'controllers/AiController';
import { appendAiCall, readAiCalls } from 'utils/aiCallLog';
import {
  addProblemTag,
  contentTree,
  createProblem,
  deleteProblem,
  deleteProblemFile,
  findProblem,
  findProblemBySlug,
  listProblemFiles,
  listProblemTags,
  listTags,
  ProblemFile,
  removeProblemTag,
  reseedAlgorithms,
  saveImportedProblem,
  upsertProblemFile,
} from 'utils/db';
import { htmlToMarkdown } from 'utils/htmlToMarkdown';
import { createKey } from 'utils/hierarchy';
import { fetchLlmModels } from 'utils/llmModels';
import Server from 'Server';

// Imported starter code (LeetCode snippets, hand-pasted files)
// arrives WITHOUT the tracer library import - LeetCode code
// never has one - so a pad created from it cannot reference any
// tracer until the user adds the import by hand (Python only
// seemed fine because its launcher pre-imports the library).
// Saving through the admin therefore prepends the import line
// for code files that lack it, the same line the app's own
// skeletons carry. Files that already import the library, and
// non-code files, pass through untouched.
const TRACER_IMPORT_BY_EXT: { [ext: string]: { marker: RegExp, line: string } } = {
  java: { marker: /org\.algorithm_visualizer/, line: 'import org.algorithm_visualizer.*;' },
  js: { marker: /require\(\s*['"]algorithm-visualizer['"]\)|from\s+['"]algorithm-visualizer['"]/, line: "const { Tracer, Array1DTracer, Array2DTracer, LogTracer, ChartTracer, GraphTracer, Layout, HorizontalLayout, VerticalLayout } = require('algorithm-visualizer');" },
  py: { marker: /\balgorithm_visualizer\b/, line: 'from algorithm_visualizer import *' },
  cpp: { marker: /algorithm[-_]visualizer/, line: '#include "algorithm-visualizer.h"' },
};

function ensureTracerImport(name: string, content: string): string {
  if (!content.trim()) return content;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const spec = TRACER_IMPORT_BY_EXT[ext];
  if (!spec || spec.marker.test(content)) return content;
  return `${spec.line}\n\n${content}`;
}

// Admin console, served at /api/admin (page) with JSON endpoints under
// /api/admin/*. Content lives in the SQLite store (utils/db): the
// content endpoints below are addressed the way the UI thinks -
// (source, category=tag, algorithm=title, file) - and translated to
// problem rows. Edits are durable in the database and take effect
// immediately (hierarchy.refresh() after every mutation).
//
// A problem's files are shared by all its categories (tags); only
// code sessions are per category. Removing an algorithm from a
// category removes that tag; the problem itself is deleted when its
// last tag goes. There is deliberately no auth: local / intranet use
// only - do not expose it publicly.
const ROOTS: { [name: string]: string } = {
  algorithms: 'algorithm',
  leetcode: 'leetcode',
};

function rootOf(source: any): string | null {
  return ROOTS[String(source)] || null;
}

interface AdminCase { name: string, args: any[], expected: any }

function validCases(raw: any): AdminCase[] | null {
  if (!Array.isArray(raw)) return null;
  const cases: AdminCase[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.args)) return null;
    cases.push({
      name: typeof item.name === 'string' && item.name ? item.name.slice(0, 60) : `Case ${cases.length + 1}`,
      args: item.args,
      expected: item.expected === undefined ? null : item.expected,
    });
  }
  return cases;
}

// Finds a JSON object in an LLM reply: the whole text, a fenced
// block, or the first balanced {...} span.
function extractJsonObject(content: string): any | null {
  const candidates: string[] = [];
  const trimmed = String(content || '').trim();
  candidates.push(trimmed);
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
      // try the next shape
    }
  }
  return null;
}

function parseLeetcodeSlug(input: any): string | null {
  const text = String(input || '').trim();
  const fromUrl = text.match(/leetcode\.(?:com|cn)\/problems\/([a-z0-9-]+)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  if (/^[a-z0-9-]+$/i.test(text)) return text.toLowerCase();
  return null;
}

export class AdminController extends Controller {
  constructor(server: Server) {
    super(server);
    this.router.get('/', this.page);
    this.router.get('/content', this.getContent);
    this.router.get('/content/file', this.getFile);
    this.router.put('/content/file', this.putFile);
    this.router.post('/content/algorithm', this.createAlgorithm);
    this.router.delete('/content/algorithm', this.deleteAlgorithm);
    this.router.post('/content/file', this.createFile);
    this.router.delete('/content/file', this.deleteFile);
    this.router.post('/content/refresh', this.refreshContent);
    this.router.post('/content/repull', this.repullContent);
    this.router.get('/tags', this.getTags);
    this.router.post('/leetcode/fetch', this.fetchLeetcode);
    this.router.post('/leetcode/generate', this.generateLeetcode);
    this.router.post('/problems', this.saveProblem);
    this.router.get('/ai-calls', this.getAiCalls);
    this.router.get('/llm-models', this.getLlmModels);
  }

  route = (router: express.Router): void => {
    router.use('/admin', this.router);
  };

  page = (req: express.Request, res: express.Response) => {
    res.sendFile(path.resolve(__dirname, 'admin.html'));
  };

  private adminTree(root: string) {
    return contentTree(root).map(category => ({
      category: category.category,
      algorithms: category.algorithms.map(algorithm => ({name: algorithm.title, files: algorithm.files})),
    }));
  }

  getContent = (req: express.Request, res: express.Response) => {
    res.json({algorithms: this.adminTree('algorithm'), leetcode: this.adminTree('leetcode')});
  };

  getFile = (req: express.Request, res: express.Response) => {
    const query: any = req.query;
    const root = rootOf(query.source);
    const problem = root ? findProblem(root, String(query.category || ''), String(query.algorithm || '')) : undefined;
    if (!problem) return res.status(404).json({message: 'Problem not found.'});
    const file = listProblemFiles(problem.id).find(entry => entry.name === String(query.file || ''));
    if (!file) return res.status(404).json({message: 'File not found.'});
    return res.json({content: file.content});
  };

  putFile = (req: express.Request, res: express.Response) => {
    const {source, category, algorithm, file, content} = req.body || {};
    const root = rootOf(source);
    const problem = root ? findProblem(root, String(category || ''), String(algorithm || '')) : undefined;
    if (!problem) return res.status(404).json({message: 'Problem not found.'});
    if (typeof file !== 'string' || !file || file.includes('/') || file.length > 120) {
      return res.status(400).json({message: 'Invalid file name.'});
    }
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) {
      return res.status(400).json({message: 'Content missing or too large.'});
    }
    upsertProblemFile(problem.id, file, content);
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  createAlgorithm = (req: express.Request, res: express.Response) => {
    const {source, category, name} = req.body || {};
    const root = rootOf(source);
    if (!root || typeof category !== 'string' || !category.trim() || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({message: 'A source, a category and a name are required.'});
    }
    const title = name.trim();
    const tag = category.trim();
    if (findProblem(root, tag, title)) return res.json({ok: true, existed: true});
    const sameSlug = findProblemBySlug(root, createKey(title));
    if (sameSlug && sameSlug.title === title) {
      // The same problem in another category: just add this tag, so
      // it now appears in both - with one shared set of files.
      addProblemTag(sameSlug.id, tag);
      this.server.hierarchy.refresh();
      return res.json({ok: true, linked: true});
    }
    createProblem({root, title, source: 'manual', tags: [tag], files: [{name: 'README.md', content: `# ${title}\n`}]});
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  deleteAlgorithm = (req: express.Request, res: express.Response) => {
    const query: any = req.query;
    const root = rootOf(query.source);
    const problem = root ? findProblem(root, String(query.category || ''), String(query.algorithm || '')) : undefined;
    if (!problem) return res.status(404).json({message: 'Problem not found.'});
    removeProblemTag(problem.id, String(query.category || ''));
    const deleted = listProblemTags(problem.id).length === 0;
    if (deleted) deleteProblem(problem.id);
    this.server.hierarchy.refresh();
    return res.json({ok: true, deleted});
  };

  createFile = (req: express.Request, res: express.Response) => {
    const {source, category, algorithm, name} = req.body || {};
    const root = rootOf(source);
    const problem = root ? findProblem(root, String(category || ''), String(algorithm || '')) : undefined;
    if (!problem) return res.status(404).json({message: 'Problem not found.'});
    if (typeof name !== 'string' || !name || name.includes('/') || name.length > 120) {
      return res.status(400).json({message: 'Invalid file name.'});
    }
    if (listProblemFiles(problem.id).some(file => file.name === name)) {
      return res.status(409).json({message: 'File already exists.'});
    }
    upsertProblemFile(problem.id, name, '');
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  deleteFile = (req: express.Request, res: express.Response) => {
    const query: any = req.query;
    const root = rootOf(query.source);
    const problem = root ? findProblem(root, String(query.category || ''), String(query.algorithm || '')) : undefined;
    if (!problem) return res.status(404).json({message: 'Problem not found.'});
    deleteProblemFile(problem.id, String(query.file || ''));
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  refreshContent = (req: express.Request, res: express.Response) => {
    this.server.hierarchy.refresh();
    res.json({ok: true});
  };

  // Re-seed: replaces every seed-sourced problem with the bundled
  // algorithms/ content (imported problems are untouched).
  repullContent = (req: express.Request, res: express.Response) => {
    try {
      const count = reseedAlgorithms();
      this.server.hierarchy.refresh();
      return res.json({ok: true, count});
    } catch (error) {
      return res.status(400).json({message: (error as Error).message});
    }
  };

  getTags = (req: express.Request, res: express.Response) => {
    const root = rootOf(req.query.source) || 'leetcode';
    res.json({tags: listTags(root)});
  };

  // Fetches a problem statement from LeetCode's public GraphQL API
  // and converts it to the app's Markdown, with the official starter
  // snippets and example test cases for the AI formatting pass.
  fetchLeetcode = async (req: express.Request, res: express.Response) => {
    const slug = parseLeetcodeSlug((req.body || {}).input);
    if (!slug) return res.status(400).json({message: 'Paste a LeetCode problem URL or its slug (e.g. two-sum).'});
    const query = `query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionFrontendId title titleSlug difficulty content isPaidOnly
        topicTags { name }
        codeSnippets { lang langSlug code }
        exampleTestcases
      }
    }`;
    try {
      const {data} = await axios.post('https://leetcode.com/graphql', {query, variables: {titleSlug: slug}}, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          Referer: `https://leetcode.com/problems/${slug}/`,
        },
        timeout: 20000,
      });
      const question = data && data.data && data.data.question;
      if (!question) return res.status(404).json({message: `LeetCode has no problem with slug "${slug}".`});
      // For paid-only problems LeetCode's public API returns
      // content: null while title, difficulty, topics, snippets
      // and example cases still arrive. That is enough to import
      // the problem - the statement itself is pasted in by hand
      // on the admin page (flagged via statementMissing) instead
      // of failing here or, worse, at the AI-format step.
      const markdown = htmlToMarkdown(question.content || '');
      return res.json({
        frontendId: question.questionFrontendId,
        title: question.title,
        slug: question.titleSlug,
        difficulty: question.difficulty,
        isPaidOnly: !!question.isPaidOnly,
        statementMissing: !markdown,
        topics: (question.topicTags || []).map((tag: any) => tag.name),
        markdown,
        snippets: (question.codeSnippets || []).map((snippet: any) => ({lang: snippet.lang, langSlug: snippet.langSlug, code: snippet.code})),
        exampleTestcases: question.exampleTestcases || '',
      });
    } catch (error) {
      const status = error && error.response && error.response.status;
      return res.status(502).json({
        message: `Fetching from LeetCode failed${status ? ` (HTTP ${status})` : ''}: ${(error as Error).message} - check the network connection and the slug.`,
      });
    }
  };

  // AI formatting pass: turns the fetched statement into the app's
  // README format and derives entry point + test cases from the
  // statement examples. Same call chain (and log) as the assistant.
  generateLeetcode = async (req: express.Request, res: express.Response) => {
    const {title, markdown, exampleTestcases, model} = req.body || {};
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({message: 'The title field is empty - fetch a problem first, or type the title in.'});
    }
    if (typeof markdown !== 'string' || !markdown.trim()) {
      return res.status(400).json({message: 'The problem statement is empty - fetch a problem first, or paste the statement into the README box.'});
    }
    const startedAt = Date.now();
    const messages = [
      {
        role: 'system',
        content: [
          'You format LeetCode problems for a code-visualization app and write its test cases.',
          'Reply with a single JSON object only - no prose, no code fences: {"readme": "...", "entry": "...", "cases": [{"name": "...", "args": [...], "expected": ...}]}.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Problem title (use it verbatim as the first line, as "# ${title}"): ${title}`,
          '',
          'Statement in Markdown (converted from LeetCode HTML; clean it up without changing its meaning):',
          markdown.slice(0, 12000),
          '',
          `LeetCode example test case inputs (newline-separated values, one argument per line, in order): ${exampleTestcases || '(none provided)'}`,
          '',
          'Rules for "readme": the title line, then the cleaned statement, keeping the examples and constraints sections. Do not add a solution or hints.',
          'Rules for "entry": the name of the function or Solution method the test cases call (as it appears in the starter code).',
          'Rules for "cases": args is the JSON array of call arguments in order; expected is the JSON value returned. Start with every example from the statement (decode the example inputs above), then add typical and edge cases, at most 10 in total. Compute every expected value correctly.',
        ].join('\n'),
      },
    ];
    try {
      const {content, usedModel, totalAttempts} = await callLlm(messages, typeof model === 'string' && model ? model : null);
      const parsed = extractJsonObject(content);
      const cases = parsed ? validCases(parsed.cases) : null;
      if (!parsed || typeof parsed.readme !== 'string' || !parsed.readme.trim() || !cases) {
        appendAiCall({
          ts: new Date().toISOString(), status: 'error', model: usedModel, language: 'markdown',
          instruction: 'admin-leetcode-generate', context: null, history: null, code: '', messages,
          rawResponse: content, reply: null, syntax: null,
          error: `The model did not return the expected JSON (after ${totalAttempts} attempt(s)).`, durationMs: Date.now() - startedAt,
        });
        return res.status(502).json({message: 'The model did not return the expected JSON. Try again, or save the fetched markdown as-is.'});
      }
      appendAiCall({
        ts: new Date().toISOString(), status: 'ok', model: usedModel, language: 'markdown',
        instruction: 'admin-leetcode-generate', context: null, history: null, code: '', messages,
        rawResponse: content, reply: {code: '', explanation: `Generated README + ${cases.length} cases for ${title}`, changed: false},
        syntax: null, error: null, durationMs: Date.now() - startedAt,
      });
      return res.json({
        readme: parsed.readme,
        entry: typeof parsed.entry === 'string' ? parsed.entry : '',
        cases,
        model: usedModel,
      });
    } catch (error) {
      const status = (error as any).status || 502;
      appendAiCall({
        ts: new Date().toISOString(), status: status === 503 ? 'not_configured' : 'error', model: null, language: 'markdown',
        instruction: 'admin-leetcode-generate', context: null, history: null, code: '', messages,
        rawResponse: null, reply: null, syntax: null, error: (error as Error).message, durationMs: Date.now() - startedAt,
      });
      return res.status(status).json({message: (error as Error).message});
    }
  };

  // Saves an imported problem (create or full replace by slug),
  // with the tags the user picked and the files assembled by the
  // import flow (README, starter code per language, tests.json).
  saveProblem = (req: express.Request, res: express.Response) => {
    const body = req.body || {};
    const root = rootOf(body.source) || 'leetcode';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) return res.status(400).json({message: 'A problem title (up to 200 chars) is required.'});
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag: any) => typeof tag === 'string' && tag.trim()).map((tag: string) => tag.trim().slice(0, 100)) : [];
    if (!tags.length) return res.status(400).json({message: 'Pick at least one category (tag) for the problem.'});
    // A problem has exactly ONE difficulty but any number of
    // topics; both travel as tags (categories are tags here),
    // so the singularity is enforced at this choke point -
    // the import form offers difficulty as a single-choice
    // radio for the same reason.
    const difficultyTags = tags.filter((tag: string) => ['Easy', 'Medium', 'Hard'].includes(tag));
    if (difficultyTags.length > 1) return res.status(400).json({message: `A problem has exactly one difficulty - it was given ${difficultyTags.length} (${difficultyTags.join(', ')}). Keep one of Easy / Medium / Hard.`});
    if (!Array.isArray(body.files) || !body.files.length) return res.status(400).json({message: 'The problem needs at least one file (its README).'});
    const files: ProblemFile[] = [];
    let total = 0;
    for (const file of body.files) {
      if (!file || typeof file.name !== 'string' || !file.name || file.name.includes('/') || file.name.length > 120 || typeof file.content !== 'string') {
        return res.status(400).json({message: 'Every file needs a valid name and string content.'});
      }
      total += file.content.length;
      if (total > 4 * 1024 * 1024) return res.status(400).json({message: 'Files are too large in total (over 4 MB).'});
      files.push({name: file.name, content: ensureTracerImport(file.name, file.content)});
    }
    if (body.tests && typeof body.tests === 'object') {
      const cases = validCases(body.tests.cases);
      if (cases && cases.length) {
        const testsJson = JSON.stringify({entry: typeof body.tests.entry === 'string' ? body.tests.entry : '', cases}, null, 2);
        const existing = files.findIndex(file => file.name === 'tests.json');
        if (existing >= 0) files[existing] = {name: 'tests.json', content: testsJson};
        else files.push({name: 'tests.json', content: testsJson});
      }
    }
    const problem = saveImportedProblem({root, title, tags, files});
    this.server.hierarchy.refresh();
    return res.json({ok: true, id: problem.id, slug: problem.slug});
  };

  getAiCalls = (req: express.Request, res: express.Response) => {
    const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
    const offset = parseInt(String(req.query.offset || '0'), 10) || 0;
    const { calls, total } = readAiCalls(limit, offset);
    res.json({ calls, total, limit, offset });
  };

  // Which models the configured API key can use - see utils/llmModels.
  getLlmModels = async (req: express.Request, res: express.Response) => {
    try {
      const result = await fetchLlmModels();
      if (!result) {
        return res.status(503).json({message: 'No LLM is configured on this server (LLM_BASE_URL / LLM_API_KEY missing in server/.env).'});
      }
      return res.json(result);
    } catch (error) {
      const status = error && error.response && error.response.status;
      const upstream = error && error.response && error.response.data && error.response.data.error && error.response.data.error.message;
      return res.status(502).json({
        message: `Listing models failed: ${upstream || (error && error.message) || 'unknown error'}${status ? ` (HTTP ${status})` : ''}`,
      });
    }
  };
}
