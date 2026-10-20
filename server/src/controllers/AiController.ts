import express from 'express';
import axios from 'axios';
import { Controller } from 'controllers/Controller';
import Server from 'Server';

// AI coding assistant for the editor ("coding pad"). The frontend sends
// the current file and an instruction; the server makes ONE
// chat-completions call to the configured OpenAI-compatible endpoint
// and returns the complete revised file plus a short explanation.
// Configuration lives in server/.env and is never shipped to the
// frontend: LLM_BASE_URL (e.g. Gemini's OpenAI-compatible endpoint),
// LLM_API_KEY, LLM_MODEL. Without them the endpoint answers 503 so the
// UI can say exactly what is missing instead of failing obscurely.

const LANGUAGE_GUIDES: { [ext: string]: string } = {
  js: `JavaScript (runs in the browser). Imports: const { Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer, Layout, HorizontalLayout, VerticalLayout, Tracer, Randomize } = require('algorithm-visualizer');
Key methods: tracer.set(data); Array tracers: patch(x, y, value) / depatch, select / deselect (also selectRow / selectCol / deselectRow / deselectCol); ChartTracer is an Array1DTracer shown as bars; GraphTracer: directed(bool), weighted(bool), addNode(id, weight, x, y), addEdge(source, target, weight), visit(target, source), leave(target, source), layoutCircle(), layoutTree(root), layoutRandom(); LogTracer: print / println. Call Tracer.delay() after each visualized step, and Layout.setRoot(new VerticalLayout([tracerA, tracerB])) (or a single tracer) once before stepping.`,
  java: `Java (compiled locally by the server). Imports: import org.algorithm_visualizer.*; The file must define class Main with public static void main(String[] args). Tracers: Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer - same method names as JavaScript (camelCase): set, patch, depatch, select, deselect, selectRow, selectCol, addNode, addEdge, visit, leave, layoutCircle, layoutTree, println. Call Tracer.delay() after each visualized step, and Layout.setRoot(new VerticalLayout(new Commander[]{tracerA, tracerB})) once before stepping.`,
  py: `Python (runs locally on the server). Imports: from algorithm_visualizer import *. Tracers: Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer - snake_case methods: set, patch, depatch, select, deselect, select_row, select_col, add_node, add_edge, visit, leave, layout_circle, layout_tree, println (camelCase aliases also work). Call Tracer.delay() after each visualized step (it captures the line number automatically), and Layout.set_root(...) once before stepping.`,
  cpp: `C++ (compiled in a local Docker container). Include: #include "algorithm-visualizer.h". Tracers: Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer - same method names as JavaScript: set, patch, depatch, select, deselect, selectRow, selectCol, addNode, addEdge, visit, leave, layoutCircle, layoutTree, println. Call Tracer::delay() after each visualized step, and set the root layout once before stepping, following the boilerplate already present in the file.`,
};

function systemPrompt(ext: string) {
  const guide = LANGUAGE_GUIDES[ext] || LANGUAGE_GUIDES.js;
  return [
    'You are the coding assistant inside Algorithm Visualizer, an app that animates algorithms from code.',
    'You receive one source file and an instruction. Do the work and answer with ONLY a JSON object:',
    '{"code": "<the COMPLETE revised file content>", "explanation": "<short explanation in Chinese>"}',
    'Rules:',
    '- code must be the entire file, ready to replace the old one - never a diff, never a snippet, never wrapped in markdown fences (the JSON carries it).',
    '- Keep the file\'s existing boilerplate and section markers (// import visualization libraries { ... // }, // define tracer variables { ... // }, // visualize { ... // }) and its overall structure; change only what the instruction needs.',
    '- When asked to visualize / add tracers: instrument the algorithm with the tracer API below, call delay after each meaningful step, set the root layout once, and keep the algorithm logic itself unchanged.',
    '- If the instruction only asks for an explanation, return the code unchanged and put the explanation in the explanation field.',
    '',
    guide,
  ].join('\n');
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
    const {code, language, instruction} = req.body;
    if (typeof code !== 'string' || typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({message: '请求缺少 code 或 instruction。'});
    }
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env['LLM_API' + '_KEY'];
    const model = process.env.LLM_MODEL;
    if (!baseUrl || !apiKey || !model) {
      return res.status(503).json({
        message: '服务器未配置 LLM。请在 server/.env 里设置 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 后重启 server。',
      });
    }
    try {
      const {data} = await axios.post(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        model,
        temperature: 0.2,
        messages: [
          {role: 'system', content: systemPrompt(String(language || 'js'))},
          {role: 'user', content: `Instruction:\n${instruction}\n\nCurrent file:\n${code}`},
        ],
      }, {
        headers: {Authorization: `Bearer ${apiKey}`},
        timeout: 90000,
      });
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string') {
        return res.status(502).json({message: 'LLM 返回了无法识别的内容。'});
      }
      return res.json(parseReply(content));
    } catch (error) {
      const upstream = error && error.response && error.response.data && error.response.data.error && error.response.data.error.message;
      return res.status(502).json({message: `LLM 调用失败：${upstream || (error && error.message) || 'unknown error'}`});
    }
  };
}
