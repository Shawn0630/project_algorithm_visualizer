import express from 'express';
import { Controller } from 'controllers/Controller';
import { deletePadChats, listPadChats, putPadChats } from 'utils/db';
import Server from 'Server';

// Per-pad AI assistant chat storage in the SQLite database
// (utils/db, table pad_chats), keyed exactly like the code cache
// and the test-case store:
//   GET    /api/pad-chats          -> {entries: {key: record}}
//   PUT    /api/pad-chats          body {key, messages?, pending?}
//                                  (partial merge; returns {ok, record})
//   DELETE /api/pad-chats?key=...  removes one pad's record
// A record is {messages, pending, ts}: the AI Assistant pane's
// session for one pad - the Code AI / Note AI conversation and a
// still-pending proposal. The test-case generation chat is not
// here; it rides in the pad_tests record's chat field.
export class PadChatsController extends Controller {
  constructor(server: Server) {
    super(server);
    this.router.get('/', this.list);
    this.router.put('/', this.put);
    this.router.delete('/', this.remove);
  }

  route = (router: express.Router): void => {
    router.use('/pad-chats', this.router);
  };

  list = async (req: express.Request, res: express.Response) => {
    try {
      return res.json({ entries: listPadChats() });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Reading the chat store failed.' });
    }
  };

  put = async (req: express.Request, res: express.Response) => {
    const { key, messages, pending } = (req.body || {}) as any;
    if (typeof key !== 'string' || !key || key.length > 300) {
      return res.status(400).json({ message: 'A pad key (up to 300 chars) is required.' });
    }
    if (messages !== undefined && (!Array.isArray(messages) || messages.length > 1000 || JSON.stringify(messages).length > 2097152)) {
      return res.status(400).json({ message: 'Messages must be an array of at most 1000 items (2 MB).' });
    }
    if (pending !== undefined && pending !== null && (typeof pending !== 'object' || Array.isArray(pending) || JSON.stringify(pending).length > 1048576)) {
      return res.status(400).json({ message: 'Pending must be a proposal object or null (1 MB).' });
    }
    try {
      const record = putPadChats(key, { messages, pending });
      return res.json({ ok: true, record });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Writing the chat store failed.' });
    }
  };

  remove = async (req: express.Request, res: express.Response) => {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key) {
      return res.status(400).json({ message: 'A pad key is required (?key=...).' });
    }
    try {
      deletePadChats(key);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'Deleting from the chat store failed.' });
    }
  };
}
