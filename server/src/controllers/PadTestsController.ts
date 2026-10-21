import express from 'express';
import { Controller } from 'controllers/Controller';
import { deletePadTests, listPadTests, putPadTests } from 'utils/db';
import Server from 'Server';

// Per-pad test-case storage in the SQLite database (utils/db,
// table pad_tests), keyed exactly like the code cache:
//   GET    /api/pad-tests          -> {entries: {key: record}}
//   PUT    /api/pad-tests          body {key, entry?, cases?, chat?, seededFrom?}
//                                  (partial merge; returns {ok, record})
//   DELETE /api/pad-tests?key=...  removes one pad's record
// A record is {entry, cases, chat, seededFrom, ts}: the Testcase
// panel's case list (in its text form) and the pad's test-case
// generation chat history.
export class PadTestsController extends Controller {
  constructor(server: Server) {
    super(server);
    this.router.get('/', this.list);
    this.router.put('/', this.put);
    this.router.delete('/', this.remove);
  }

  route = (router: express.Router): void => {
    router.use('/pad-tests', this.router);
  };

  list = async (req: express.Request, res: express.Response) => {
    try {
      return res.json({ entries: listPadTests() });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Reading the test-case store failed.' });
    }
  };

  put = async (req: express.Request, res: express.Response) => {
    const { key, entry, cases, chat, seededFrom } = (req.body || {}) as any;
    if (typeof key !== 'string' || !key || key.length > 300) {
      return res.status(400).json({ message: 'A pad key (up to 300 chars) is required.' });
    }
    if (entry !== undefined && (typeof entry !== 'string' || entry.length > 200)) {
      return res.status(400).json({ message: 'Entry must be a string of at most 200 chars.' });
    }
    if (cases !== undefined && (!Array.isArray(cases) || cases.length > 200 || JSON.stringify(cases).length > 262144)) {
      return res.status(400).json({ message: 'Cases must be an array of at most 200 items (256 KB).' });
    }
    if (chat !== undefined && (!Array.isArray(chat) || chat.length > 200 || JSON.stringify(chat).length > 524288)) {
      return res.status(400).json({ message: 'Chat must be an array of at most 200 messages (512 KB).' });
    }
    if (seededFrom !== undefined && seededFrom !== null && (typeof seededFrom !== 'string' || seededFrom.length > 1048576)) {
      return res.status(400).json({ message: 'seededFrom must be a string or null.' });
    }
    try {
      const record = putPadTests(key, { entry, cases, chat, seededFrom });
      return res.json({ ok: true, record });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Writing the test-case store failed.' });
    }
  };

  remove = async (req: express.Request, res: express.Response) => {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key) {
      return res.status(400).json({ message: 'A pad key is required (?key=...).' });
    }
    try {
      deletePadTests(key);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Deleting from the test-case store failed.' });
    }
  };
}
