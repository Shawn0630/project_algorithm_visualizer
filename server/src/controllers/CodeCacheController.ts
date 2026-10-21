import express from 'express';
import { Controller } from 'controllers/Controller';
import { listCodeCache, putCodeCache, deleteCodeCache } from 'utils/codeCache';
import Server from 'Server';

// The server tier of the per-pad code copies (see utils/codeCache):
//   GET    /api/code-cache           -> {entries: {key: {content, ts}}}
//   PUT    /api/code-cache           body {key, content, ts?}
//   DELETE /api/code-cache?key=...   removes one pad's copy
export class CodeCacheController extends Controller {
  constructor(server: Server) {
    super(server);
    this.router.get('/', this.list);
    this.router.put('/', this.put);
    this.router.delete('/', this.remove);
  }

  route = (router: express.Router): void => {
    router.use('/code-cache', this.router);
  };

  list = async (req: express.Request, res: express.Response) => {
    try {
      return res.json({ entries: await listCodeCache() });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Reading the code cache failed.' });
    }
  };

  put = async (req: express.Request, res: express.Response) => {
    const { key, content, ts } = (req.body || {}) as any;
    if (typeof key !== 'string' || !key || key.length > 300) {
      return res.status(400).json({ message: 'A pad key (up to 300 chars) is required.' });
    }
    if (typeof content !== 'string' || content.length > 512000) {
      return res.status(400).json({ message: 'Content must be a string of at most 512 KB.' });
    }
    try {
      await putCodeCache(key, content, typeof ts === 'number' ? ts : undefined);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Writing the code cache failed.' });
    }
  };

  remove = async (req: express.Request, res: express.Response) => {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key) {
      return res.status(400).json({ message: 'A pad key is required (?key=...).' });
    }
    try {
      await deleteCodeCache(key);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Deleting from the code cache failed.' });
    }
  };
}
