import express from 'express';
import fs from 'fs';
import path from 'path';
import { Controller } from 'controllers/Controller';
import { algorithmsDir, leetcodeDir } from 'config/paths';
import { readAiCalls } from 'utils/aiCallLog';
import { fetchLlmModels } from 'utils/llmModels';
import Server from 'Server';

// Admin console, served at /api/admin (page) with JSON endpoints under
// /api/admin/*. It manages the content working copies the server
// serves from (server/public/algorithms and server/public/leetcode)
// and shows the AI assistant call log. There is deliberately no auth:
// like the rest of this server it is meant for local / intranet use
// only - do not expose it publicly.
//
// Content edits land in the working copies and are picked up by the
// app immediately (hierarchy.refresh() after every mutation). They do
// NOT commit anything: the next content pull (server start) resets
// the working copies from the LAN git server, so durable changes
// belong in those repos.
const SOURCES: { [name: string]: string } = {
  algorithms: algorithmsDir,
  leetcode: leetcodeDir,
};

function safeSegment(value: any): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

function removeDir(dir: string): void {
  const fsAny = fs as any;
  if (typeof fsAny.rmSync === 'function') fsAny.rmSync(dir, {recursive: true, force: true});
  else (fs.rmdirSync as any)(dir, {recursive: true});
}

function tree(root: string) {
  if (!fs.existsSync(root)) return [];
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return (fs.readdirSync as any)(root, {withFileTypes: true})
    .filter((entry: any) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((category: any) => ({
      category: category.name,
      algorithms: (fs.readdirSync as any)(path.join(root, category.name), {withFileTypes: true})
        .filter((entry: any) => entry.isDirectory())
        .map((algorithm: any) => ({
          name: algorithm.name,
          files: (fs.readdirSync as any)(path.join(root, category.name, algorithm.name), {withFileTypes: true})
            .filter((entry: any) => entry.isFile())
            .map((file: any) => file.name)
            .sort(),
        }))
        .sort(byName),
    }))
    .sort((a: any, b: any) => a.category.localeCompare(b.category));
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
    this.router.get('/ai-calls', this.getAiCalls);
    this.router.get('/llm-models', this.getLlmModels);
  }

  route = (router: express.Router): void => {
    router.use('/admin', this.router);
  };

  page = (req: express.Request, res: express.Response) => {
    res.sendFile(path.resolve(__dirname, 'admin.html'));
  };

  // Resolves a content path from validated segments, or null when any
  // segment is unsafe / the source is unknown.
  private contentPath(source: any, category: any, algorithm?: any, file?: any): string | null {
    const root = SOURCES[String(source)];
    if (!root || !safeSegment(category)) return null;
    const segments = [category];
    if (algorithm !== undefined) {
      if (!safeSegment(algorithm)) return null;
      segments.push(algorithm);
    }
    if (file !== undefined) {
      if (!safeSegment(file)) return null;
      segments.push(file);
    }
    const resolved = path.resolve(root, ...segments);
    return resolved.startsWith(root + path.sep) ? resolved : null;
  }

  getContent = (req: express.Request, res: express.Response) => {
    res.json({algorithms: tree(algorithmsDir), leetcode: tree(leetcodeDir)});
  };

  getFile = (req: express.Request, res: express.Response) => {
    const query: any = req.query;
    const {source, category, algorithm, file} = query;
    const filePath = this.contentPath(source, category, algorithm, file);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({message: '文件不存在或路径不合法。'});
    res.json({content: fs.readFileSync(filePath, 'utf8')});
  };

  putFile = (req: express.Request, res: express.Response) => {
    const {source, category, algorithm, file, content} = req.body;
    const filePath = this.contentPath(source, category, algorithm, file);
    if (!filePath) return res.status(400).json({message: '路径不合法。'});
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) {
      return res.status(400).json({message: '内容缺失或过大。'});
    }
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, content);
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  createAlgorithm = (req: express.Request, res: express.Response) => {
    const {source, category, name} = req.body;
    const dir = this.contentPath(source, category, name);
    if (!dir) return res.status(400).json({message: '路径不合法。'});
    fs.mkdirSync(dir, {recursive: true});
    const readme = path.join(dir, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# ${name}\n`);
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  deleteAlgorithm = (req: express.Request, res: express.Response) => {
    const query: any = req.query;
    const {source, category, algorithm} = query;
    const dir = this.contentPath(source, category, algorithm);
    if (!dir || !fs.existsSync(dir)) return res.status(404).json({message: '算法不存在或路径不合法。'});
    removeDir(dir);
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  createFile = (req: express.Request, res: express.Response) => {
    const {source, category, algorithm, name} = req.body;
    const filePath = this.contentPath(source, category, algorithm, name);
    if (!filePath) return res.status(400).json({message: '路径不合法。'});
    if (fs.existsSync(filePath)) return res.status(409).json({message: '文件已存在。'});
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, '');
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  deleteFile = (req: express.Request, res: express.Response) => {
    const query: any = req.query;
    const {source, category, algorithm, file} = query;
    const filePath = this.contentPath(source, category, algorithm, file);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({message: '文件不存在或路径不合法。'});
    fs.unlinkSync(filePath);
    this.server.hierarchy.refresh();
    return res.json({ok: true});
  };

  refreshContent = (req: express.Request, res: express.Response) => {
    this.server.hierarchy.refresh();
    res.json({ok: true});
  };

  repullContent = async (req: express.Request, res: express.Response) => {
    await this.server.hierarchy.update();
    res.json({ok: true});
  };

  getAiCalls = (req: express.Request, res: express.Response) => {
    const limit = parseInt(String(req.query.limit || '50'), 10) || 50;
    res.json({calls: readAiCalls(limit)});
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
