import express from 'express';
import { Controller } from 'controllers/Controller';
import { runTests, TestCaseSpec } from 'utils/testRunner';
import Server from 'Server';

// POST /api/tests/run - LeetCode-style test cases for a code pad.
// Body: {language, code, entry, cases: [{name, args, expected}]}.
// The code runs locally on the server (same trust model as the
// tracers) with the visualization library stubbed out.
export class TestController extends Controller {
  constructor(server: Server) {
    super(server);
    this.router.post('/run', this.run);
  }

  route = (router: express.Router): void => {
    router.use('/tests', this.router);
  };

  run = async (req: express.Request, res: express.Response) => {
    const { language, code, entry, cases } = (req.body || {}) as any;
    if (typeof code !== 'string' || !code || code.length > 512000) {
      return res.status(400).json({ message: 'A code string (up to 512 KB) is required.' });
    }
    if (typeof entry !== 'string' || !entry.trim()) {
      return res.status(400).json({ message: 'An entry function/method name is required.' });
    }
    if (!Array.isArray(cases) || cases.length < 1 || cases.length > 50) {
      return res.status(400).json({ message: 'Between 1 and 50 test cases are required.' });
    }
    const specs: TestCaseSpec[] = [];
    for (const [i, tc] of cases.entries()) {
      if (!tc || !Array.isArray(tc.args) || tc.args.length > 16) {
        return res.status(400).json({ message: `Case ${i + 1}: "args" must be an array of at most 16 JSON values.` });
      }
      specs.push({
        name: typeof tc.name === 'string' && tc.name ? tc.name : `Case ${i + 1}`,
        args: tc.args,
        expected: tc.expected === undefined ? null : tc.expected,
      });
    }
    try {
      const { results, durationMs } = await runTests(String(language || ''), code, entry.trim(), specs);
      return res.json({ results, durationMs });
    } catch (error) {
      return res.status(502).json({ message: (error as Error).message || 'The test run failed.' });
    }
  };
}
