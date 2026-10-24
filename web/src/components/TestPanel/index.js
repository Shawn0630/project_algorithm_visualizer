import React from 'react';
import { connect } from 'react-redux';
import { TestApi, PadTestsApi } from 'apis';
import { extension, aiPadKey, TESTCASES_APPLY_EVENT, VISUALIZE_CASE_EVENT, notifyLayoutChanged } from 'common/util';
import { buildCaseVisualization } from 'common/visualizeCase';
import styles from './TestPanel.module.scss';

// LeetCode-style test cases for a code pad, docked under the editor
// as its own card, with two tabs: Testcase (edit + run cases) and
// Test Result. The test-case generation CHAT lives in the AI
// Assistant pane now, as a tab beside the code AI; its Apply
// action dispatches TESTCASES_APPLY_EVENT, which this panel
// still owns the receiving end of (ingestCases below).
//
// Case storage: a tests.json file in the page's folder ({entry,
// cases: [{name, args, expected}]}) seeds a pad the first time and
// re-seeds it whenever the file changes. The working list - entry,
// cases, and the generation chat - is kept per code pad in the
// server's database (table pad_tests, via /api/pad-tests), with
// localStorage as a hot cache: edits sync to the server (debounced)
// and the server copy wins on load when it is newer, so the cases
// follow the user across browsers and machines. Runs send the pad's
// current code to the server, which calls the entry once per case
// with the JSON arguments and compares the return value against
// the expected JSON.
const RUNNABLE_EXTS = ['py', 'js', 'java'];
const STORAGE_KEY = 'av-tests-v1';

function loadStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveStore(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    // Storage unavailable: cases simply stay in memory.
  }
}

const toTextCase = tc => ({
  name: tc.name || 'Case',
  argsText: JSON.stringify(tc.args === undefined ? [] : tc.args),
  expectedText: JSON.stringify(tc.expected === undefined ? null : tc.expected),
});

const blankCase = n => ({ name: `Case ${n}`, argsText: '[]', expectedText: 'null' });

// Character-level diff of two JSON strings, for the results view:
// the parts of the actual output that differ from the expected
// value (and vice versa) come back flagged as changed segments,
// so the UI can tint them. An LCS walk over the characters;
// past the size cap the whole value is flagged when the strings
// differ at all (a giant value's diff is not worth the table).
function diffSegments(aText, bText) {
  const a = aText === undefined ? 'null' : aText;
  const b = bText === undefined ? 'null' : bText;
  if (a === b) {
    return { aSegs: [{ text: a, changed: false }], bSegs: [{ text: b, changed: false }] };
  }
  const CAP = 1200;
  if (a.length > CAP || b.length > CAP) {
    return { aSegs: [{ text: a, changed: true }], bSegs: [{ text: b, changed: true }] };
  }
  const m = a.length;
  const n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aSegs = [];
  const bSegs = [];
  const push = (segs, text, changed) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push(aSegs, a[i], false);
      push(bSegs, b[j], false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(aSegs, a[i], true);
      i++;
    } else {
      push(bSegs, b[j], true);
      j++;
    }
  }
  while (i < m) { push(aSegs, a[i], true); i++; }
  while (j < n) { push(bSegs, b[j], true); j++; }
  return { aSegs, bSegs };
}

// The part of a pad record that lives in the database. (Older
// records also carry a `chat` field from the removed test-case
// generation chat; this panel never writes that field, and the
// server merges fields partially, so it is simply left alone.)
const persistSlice = pad => ({
  entry: pad.entry,
  cases: pad.cases,
  seededFrom: pad.seededFrom,
});

class TestPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      pads: loadStore(),
      tab: 'case',
      running: false,
      vizError: '',
    };
    this.sentSlices = {};
    this.syncTimers = {};
  }

  componentDidMount() {
    // The AI Assistant can hand this pad a set of generated test
    // cases (its third kind of result): they land here exactly like
    // the chat session's own output.
    this.handleApplyCases = event => {
      const detail = event.detail || {};
      if (!detail.key || detail.key !== this.padKey()) return;
      this.ingestCases(detail.entry, detail.cases, detail.mode === 'replace' ? 'replace' : 'append');
    };
    window.addEventListener(TESTCASES_APPLY_EVENT, this.handleApplyCases);
    // Hydrate from the server store: its records win when newer
    // than the local copies; local-only or newer pads upload.
    PadTestsApi.list().then(({ entries }) => {
      if (!entries) return;
      this.setState(prev => {
        const pads = { ...prev.pads };
        Object.keys(entries).forEach(key => {
          const server = entries[key];
          const local = pads[key];
          if (!local || (server.ts || 0) >= (local.ts || 0)) {
            pads[key] = {
              ...(local || {}),
              entry: typeof server.entry === 'string' ? server.entry : '',
              cases: Array.isArray(server.cases) && server.cases.length ? server.cases : [blankCase(1)],
              seededFrom: server.seededFrom === undefined ? null : server.seededFrom,
              active: local ? local.active : 0,
              open: local ? local.open : false,
              results: local ? local.results : null,
              runError: local ? local.runError : '',
              durationMs: local ? local.durationMs : null,
              ts: server.ts || 0,
            };
            this.sentSlices[key] = JSON.stringify(persistSlice(pads[key]));
          }
        });
        return { pads };
      }, () => {
        const key = this.padKey();
        if (key) this.scheduleSync(key);
      });
    }).catch(() => {
      // Server unreachable: the localStorage copies carry on alone.
    });
  }

  componentWillUnmount() {
    window.removeEventListener(TESTCASES_APPLY_EVENT, this.handleApplyCases);
    Object.values(this.syncTimers).forEach(timer => window.clearTimeout(timer));
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.pads !== this.state.pads) {
      saveStore(this.state.pads);
      const key = this.padKey();
      if (key) this.scheduleSync(key);
    }
  }

  // Debounced upload of the current pad's persisted slice, skipped
  // when nothing in the slice actually changed.
  scheduleSync(key) {
    if (this.syncTimers[key]) window.clearTimeout(this.syncTimers[key]);
    this.syncTimers[key] = window.setTimeout(() => this.syncOut(key), 500);
  }

  syncOut(key) {
    const pad = this.pad();
    if (!pad || this.padKey() !== key) return;
    const slice = persistSlice(pad);
    const json = JSON.stringify(slice);
    if (this.sentSlices[key] === json) return;
    PadTestsApi.put({ key, ...slice }).then(({ record }) => {
      this.sentSlices[key] = json;
      if (record && record.ts) {
        this.setState(prev => {
          const current = prev.pads[key];
          if (!current || current.ts === record.ts) return null;
          return { pads: { ...prev.pads, [key]: { ...current, ts: record.ts } } };
        });
      }
    }).catch(() => {
      // Offline or server down: the local copy remains the truth
      // until the next successful sync.
    });
  }

  // The file whose code is tested: the editing file when it is
  // runnable, otherwise the page's first runnable file (e.g. while
  // the tests.json pad itself is in front).
  codeFile() {
    const { editingFile, files } = this.props.current;
    if (editingFile && RUNNABLE_EXTS.includes(extension(editingFile.name))) return editingFile;
    return (files || []).find(file => RUNNABLE_EXTS.includes(extension(file.name))) || null;
  }

  // The framework for adding cases to a page: a tests.json file in
  // the page's folder - {entry, cases: [{name, args, expected}]}.
  // It is the seed: the panel re-seeds from it whenever it changes.
  defaults() {
    const { files } = this.props.current;
    const testsFile = (files || []).find(file => file.name === 'tests.json');
    if (!testsFile) return null;
    try {
      const parsed = JSON.parse(testsFile.content);
      if (!parsed || !Array.isArray(parsed.cases)) return null;
      return {
        entry: typeof parsed.entry === 'string' ? parsed.entry : '',
        cases: parsed.cases.map(toTextCase),
        raw: testsFile.content,
      };
    } catch (error) {
      return null;
    }
  }

  padKey() {
    const file = this.codeFile();
    return file ? aiPadKey(this.props.current, file.name) : null;
  }

  pad() {
    const key = this.padKey();
    if (!key) return null;
    const stored = this.state.pads[key];
    const defaults = this.defaults();
    if (defaults && (!stored || stored.seededFrom !== defaults.raw)) {
      return {
        entry: defaults.entry,
        cases: defaults.cases.length ? defaults.cases : [blankCase(1)],
        active: 0,
        // Focus layout renders the panel with startCollapsed: it
        // begins as just its header until the user opens it (a
        // stored open state always wins over that default).
        open: stored ? stored.open !== false : !this.props.startCollapsed,
        results: null,
        runError: '',
        durationMs: null,
        seededFrom: defaults.raw,
        ts: stored ? stored.ts : 0,
      };
    }
    if (stored) return stored;
    return {
      entry: '',
      cases: [blankCase(1)],
      active: 0,
      open: false,
      results: null,
      runError: '',
      durationMs: null,
      seededFrom: null,
      ts: 0,
    };
  }

  updatePad(patch, callback) {
    const key = this.padKey();
    if (!key) return;
    const current = this.pad();
    this.setState(prev => ({
      pads: { ...prev.pads, [key]: { ...current, ...patch } },
    }), callback);
    // Opening or collapsing the panel resizes the code editor
    // above it: tell the editor to re-layout (Ace otherwise leaves
    // its scrollbar layers at the old offset - the floating gray
    // bar in the layout).
    if (Object.prototype.hasOwnProperty.call(patch, 'open')) notifyLayoutChanged();
  }

  // The header tabs are the expand/collapse control (the old
  // chevron button was too small to hit reliably): clicking a tab
  // opens the panel on that tab; clicking the tab that is already
  // showing collapses the panel again.
  onTab(tab) {
    const pad = this.pad();
    if (!pad) return;
    if (!pad.open) this.updatePad({ open: true });
    else if (this.state.tab === tab) this.updatePad({ open: false });
    this.setState({ tab });
  }

  updateCase(index, patch) {
    const pad = this.pad();
    const cases = pad.cases.map((tc, i) => i === index ? { ...tc, ...patch } : tc);
    this.updatePad({ cases, results: null, runError: '' });
  }

  addCase() {
    const pad = this.pad();
    const cases = [...pad.cases, blankCase(pad.cases.length + 1)];
    this.updatePad({ cases, active: cases.length - 1, results: null, runError: '' });
  }

  removeCase(index) {
    const pad = this.pad();
    if (pad.cases.length <= 1) return;
    const cases = pad.cases.filter((_, i) => i !== index);
    this.updatePad({
      cases,
      active: Math.max(0, Math.min(pad.active, cases.length - 1)),
      results: null,
      runError: '',
    });
  }

  // Drops a set of AI-generated cases into this pad's list, then
  // runs them against the current code. Mode "append" adds the
  // cases (replacing the list when it still holds only blank
  // cases); mode "replace" swaps the whole list. Shared by the
  // AI Assistant hand-off and the generation chat's Apply button.
  ingestCases(entry, cases, mode) {
    const pad = this.pad();
    if (!pad || !Array.isArray(cases) || !cases.length) return;
    const textCases = cases.map(toTextCase);
    const blankOnly = pad.cases.every(tc => tc.argsText === '[]' && tc.expectedText === 'null');
    const merged = mode === 'replace' || blankOnly ? textCases : [...pad.cases, ...textCases];
    this.updatePad({
      entry: entry && (mode === 'replace' || !pad.entry.trim()) ? entry : pad.entry,
      cases: merged,
      active: 0,
      open: true,
      results: null,
      runError: '',
    }, () => this.run());
  }

  // Plays one case in the visualization pane: the pad's code is
  // wrapped with a generated harness that calls the entry with this
  // case's args inside the tracer environment (Input/Output narrated
  // by a LogTracer, numeric arrays shown as charts), and the Player
  // builds and auto-plays the result. The pad itself is untouched.
  visualizeCase(index) {
    const file = this.codeFile();
    const pad = this.pad();
    if (!file || !pad) return;
    const entry = pad.entry.trim();
    if (!entry) {
      this.setState({ vizError: 'Set the entry function/method name first (e.g. minOperations, or the method on class Solution).' });
      return;
    }
    const tc = pad.cases[index];
    if (!tc) return;
    let args;
    try {
      args = JSON.parse(tc.argsText);
      if (!Array.isArray(args)) throw new Error('not an array');
    } catch (error) {
      this.setState({ vizError: `${tc.name}: Args must be a JSON array, e.g. ["dog"] or [1, 2].` });
      return;
    }
    try {
      const wrapped = buildCaseVisualization(extension(file.name), file.content, entry, args);
      this.setState({ vizError: '' });
      window.dispatchEvent(new CustomEvent(VISUALIZE_CASE_EVENT, {
        detail: { code: wrapped, name: file.name },
      }));
    } catch (error) {
      this.setState({ vizError: error.message });
    }
  }

  run() {
    const file = this.codeFile();
    const pad = this.pad();
    if (!file || !pad || this.state.running) return;
    const entry = pad.entry.trim();
    if (!entry) {
      this.updatePad({ open: true, runError: 'Set the entry function/method name first (e.g. minOperations, or the method on class Solution).', results: null });
      this.setState({ tab: 'result' });
      return;
    }
    const cases = [];
    for (let i = 0; i < pad.cases.length; i++) {
      const tc = pad.cases[i];
      let args;
      let expected;
      try {
        args = JSON.parse(tc.argsText);
        if (!Array.isArray(args)) throw new Error('not an array');
      } catch (error) {
        this.updatePad({ open: true, runError: `${tc.name}: Args must be a JSON array, e.g. ["dog"] or [1, 2].`, results: null });
        this.setState({ tab: 'result' });
        return;
      }
      try {
        expected = JSON.parse(tc.expectedText);
      } catch (error) {
        this.updatePad({ open: true, runError: `${tc.name}: Expected must be valid JSON, e.g. 1 or "abc" or [1, 2].`, results: null });
        this.setState({ tab: 'result' });
        return;
      }
      cases.push({ name: tc.name, args, expected });
    }
    this.updatePad({ open: true });
    this.setState({ running: true, tab: 'result' });
    TestApi.run({
      language: extension(file.name),
      code: file.content,
      entry,
      cases,
    }).then(({ results, durationMs }) => {
      this.setState({ running: false });
      this.updatePad({ results, durationMs, runError: '' });
    }).catch(error => {
      const data = error && error.response && error.response.data;
      this.setState({ running: false });
      this.updatePad({ results: null, runError: (data && data.message) || 'The test run failed. Is the server running?' });
    });
  }

  renderResults(pad) {
    if (this.state.running) return <div className={styles.hint}>Running...</div>;
    if (pad.runError) return <pre className={styles.error}>{pad.runError}</pre>;
    if (!pad.results) {
      return <div className={styles.hint}>No run yet - press Run and the results show up here.</div>;
    }
    // Same layout as the Testcase tab: a chips row picks the case,
    // then the fields of just that case. For a failed case the
    // Output and Expected boxes carry a diff: the parts that
    // differ are tinted - red in the actual output, green in the
    // expected value - so the eye lands on the mismatch.
    const passed = pad.results.filter(r => r.pass).length;
    const active = Math.max(0, Math.min(pad.active, pad.results.length - 1));
    const r = pad.results[active];
    let argsValue = null;
    try {
      argsValue = pad.cases[active] ? JSON.parse(pad.cases[active].argsText || '[]') : null;
    } catch (error) {
      argsValue = null;
    }
    const diff = r.error ? null : diffSegments(JSON.stringify(r.actual), JSON.stringify(r.expected));
    return (
      <div>
        {this.state.vizError ? <pre className={styles.error}>{this.state.vizError}</pre> : null}
        <div className={passed === pad.results.length ? styles.summary_ok : styles.summary_bad}>
          {passed}/{pad.results.length} passed{pad.durationMs != null ? ` · ${pad.durationMs} ms` : ''}
        </div>
        <div className={styles.chips}>
          {
            pad.results.map((rr, i) => (
              <span key={i} className={`${styles.chip} ${i === active ? styles.chip_active : ''}`}
                    onClick={() => this.updatePad({ active: i })}>
                {rr.name}
                <span className={rr.pass ? styles.dot_ok : styles.dot_bad}> ●</span>
              </span>
            ))
          }
        </div>
        <div className={r.pass ? styles.result_name_ok : styles.result_name_bad}>
          {r.pass ? '✓' : '✗'} {r.name}
        </div>
        <div className={styles.field_label}>Input</div>
        <div className={styles.value_box}>{JSON.stringify(argsValue)}</div>
        {
          r.error
            ? <pre className={styles.error}>{r.error}</pre>
            : (
              <React.Fragment>
                <div className={styles.field_label}>Output</div>
                <div className={styles.value_box}>
                  {diff.aSegs.map((seg, i) => seg.changed
                    ? <span key={i} className={styles.diff_actual}>{seg.text}</span>
                    : <span key={i}>{seg.text}</span>)}
                </div>
              </React.Fragment>
            )
        }
        <div className={styles.field_label}>Expected</div>
        <div className={styles.value_box}>
          {diff
            ? diff.bSegs.map((seg, i) => seg.changed
              ? <span key={i} className={styles.diff_expected}>{seg.text}</span>
              : <span key={i}>{seg.text}</span>)
            : JSON.stringify(r.expected)}
        </div>
        {
          r.stdout
            ? <details className={styles.stdout}><summary>stdout</summary><pre>{r.stdout}</pre></details>
            : null
        }
        <div className={styles.gen_row}>
          <button className={styles.gen_btn} onClick={() => this.visualizeCase(active)}>
            ▶ Visualize this case
          </button>
        </div>
      </div>
    );
  }

  render() {
    const { files } = this.props.current;
    const file = this.codeFile();
    const hasTestsFile = (files || []).some(f => f.name === 'tests.json');
    if (!file && !hasTestsFile) return null;
    const pad = this.pad();
    if (!pad) return null;
    const { tab, running } = this.state;
    const active = Math.min(pad.active, pad.cases.length - 1);
    const passedCount = pad.results ? pad.results.filter(r => r.pass).length : null;

    return (
      <div className={styles.test_panel}>
        <div className={styles.header}>
          <button className={`${styles.tab} ${tab === 'case' ? styles.tab_active : ''}`}
                  title={pad.open && tab === 'case' ? 'Click to collapse' : 'Click to expand'}
                  onClick={() => this.onTab('case')}>
            ✓ Testcase
          </button>
          <button className={`${styles.tab} ${tab === 'result' ? styles.tab_active : ''}`}
                  title={pad.open && tab === 'result' ? 'Click to collapse' : 'Click to expand'}
                  onClick={() => this.onTab('result')}>
            &gt;_ Test Result
            {passedCount != null ? ` (${passedCount}/${pad.results.length})` : ''}
          </button>
          <span className={styles.spacer}/>
          {file ? <span className={styles.code_label}>{file.name}</span> : null}
          <button className={styles.run} disabled={!file || running} onClick={() => this.run()}>
            {running ? 'Running...' : 'Run'}
          </button>
        </div>
        {
          pad.open ? (
            <div className={styles.body}>
              {
                tab === 'case' ? (
                  <div>
                    <div className={styles.chips}>
                      {
                        pad.cases.map((tc, i) => (
                          <span key={i} className={`${styles.chip} ${i === active ? styles.chip_active : ''}`}
                                onClick={() => this.updatePad({ active: i })}>
                            {tc.name}
                            {
                              pad.results && pad.results[i]
                                ? <span className={pad.results[i].pass ? styles.dot_ok : styles.dot_bad}> ●</span>
                                : null
                            }
                            {
                              i === active && pad.cases.length > 1
                                ? <span className={styles.chip_x} onClick={e => { e.stopPropagation(); this.removeCase(i); }}>×</span>
                                : null
                            }
                          </span>
                        ))
                      }
                      <span className={styles.chip_add} onClick={() => this.addCase()}>+</span>
                    </div>
                    <div className={styles.field_label}>entry =</div>
                    <input className={styles.value_input} type="text" value={pad.entry}
                           placeholder="method on class Solution, or a top-level function"
                           onChange={e => this.updatePad({ entry: e.target.value, results: null, runError: '' })}/>
                    <div className={styles.field_label}>args =</div>
                    <textarea className={styles.value_input} rows={2} value={pad.cases[active].argsText}
                              onChange={e => this.updateCase(active, { argsText: e.target.value })}/>
                    <div className={styles.field_label}>expected =</div>
                    <input className={styles.value_input} type="text" value={pad.cases[active].expectedText}
                           onChange={e => this.updateCase(active, { expectedText: e.target.value })}/>
                    <div className={styles.gen_row}>
                      <button className={styles.gen_btn} disabled={!file} onClick={() => this.visualizeCase(active)}>
                        ▶ Visualize this case
                      </button>
                    </div>
                    {this.state.vizError ? <pre className={styles.error}>{this.state.vizError}</pre> : null}
                  </div>
                ) : this.renderResults(pad)
              }
            </div>
          ) : null
        }
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }))(TestPanel);
