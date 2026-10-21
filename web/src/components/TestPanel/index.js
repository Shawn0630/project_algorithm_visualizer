import React from 'react';
import { connect } from 'react-redux';
import { TestApi } from 'apis';
import { extension, aiPadKey } from 'common/util';
import styles from './TestPanel.module.scss';

// LeetCode-style test cases for a code pad, docked under the editor
// as its own card. The framework for adding cases to a page is a
// tests.json file in the page's folder ({entry, cases: [{name,
// args, expected}]}): it is the source of truth, it opens as a pad
// like any other file, and the panel re-seeds whenever it changes.
// Cases can also be added/edited directly in the panel - those are
// kept per code pad in localStorage and last until the file
// changes. Running sends the pad's current code to the server,
// which calls the entry function/method once per case with the
// JSON arguments and compares the return value against the
// expected JSON.
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

class TestPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { pads: loadStore(), tab: 'case', running: false };
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.pads !== this.state.pads) saveStore(this.state.pads);
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
  // It is the source of truth: edit it (it opens as a pad like any
  // file) and the panel re-seeds from it. Edits made in the panel
  // itself are local extras, kept per code pad in localStorage, and
  // last until the file changes.
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
        open: true,
        results: null,
        runError: '',
        durationMs: null,
        seededFrom: defaults.raw,
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
    };
  }

  updatePad(patch) {
    const key = this.padKey();
    if (!key) return;
    const current = this.pad();
    this.setState(prev => ({
      pads: { ...prev.pads, [key]: { ...current, ...patch } },
    }));
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

  run() {
    const file = this.codeFile();
    const pad = this.pad();
    if (!file || !pad || this.state.running) return;
    const entry = pad.entry.trim();
    if (!entry) {
      this.updatePad({ runError: 'Set the entry function/method name first (e.g. minOperations, or the method on class Solution).', results: null });
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
        this.updatePad({ runError: `${tc.name}: Args must be a JSON array, e.g. ["dog"] or [1, 2].`, results: null });
        this.setState({ tab: 'result' });
        return;
      }
      try {
        expected = JSON.parse(tc.expectedText);
      } catch (error) {
        this.updatePad({ runError: `${tc.name}: Expected must be valid JSON, e.g. 1 or "abc" or [1, 2].`, results: null });
        this.setState({ tab: 'result' });
        return;
      }
      cases.push({ name: tc.name, args, expected });
    }
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
      return <div className={styles.hint}>No run yet - press Run and the results show up here, one block per case.</div>;
    }
    const passed = pad.results.filter(r => r.pass).length;
    return (
      <div>
        <div className={passed === pad.results.length ? styles.summary_ok : styles.summary_bad}>
          {passed}/{pad.results.length} passed{pad.durationMs != null ? ` · ${pad.durationMs} ms` : ''}
        </div>
        {
          pad.results.map((r, i) => (
            <div key={i} className={styles.result_case}>
              <div className={r.pass ? styles.result_name_ok : styles.result_name_bad}>
                {r.pass ? '✓' : '✗'} {r.name}
              </div>
              <div className={styles.field_label}>Input</div>
              <div className={styles.value_box}>{JSON.stringify(pad.cases[i] ? JSON.parse(pad.cases[i].argsText || '[]') : null)}</div>
              {
                r.error
                  ? <pre className={styles.error}>{r.error}</pre>
                  : (
                    <React.Fragment>
                      <div className={styles.field_label}>Output</div>
                      <div className={styles.value_box}>{JSON.stringify(r.actual)}</div>
                    </React.Fragment>
                  )
              }
              <div className={styles.field_label}>Expected</div>
              <div className={styles.value_box}>{JSON.stringify(r.expected)}</div>
              {
                r.stdout
                  ? <details className={styles.stdout}><summary>stdout</summary><pre>{r.stdout}</pre></details>
                  : null
              }
            </div>
          ))
        }
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
                  onClick={() => this.setState({ tab: 'case' })}>
            ✓ Testcase
          </button>
          <button className={`${styles.tab} ${tab === 'result' ? styles.tab_active : ''}`}
                  onClick={() => this.setState({ tab: 'result' })}>
            &gt;_ Test Result
            {passedCount != null ? ` (${passedCount}/${pad.results.length})` : ''}
          </button>
          <span className={styles.spacer}/>
          {file ? <span className={styles.code_label}>{file.name}</span> : null}
          <button className={styles.run} disabled={!file || running} onClick={() => this.run()}>
            {running ? 'Running...' : 'Run'}
          </button>
          <button className={styles.chevron} onClick={() => this.updatePad({ open: !pad.open })}>
            {pad.open ? '▾' : '▸'}
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
                    <div className={styles.note}>
                      To add cases to a page for good, put a <code>tests.json</code> next to its code -
                      it opens as a pad here, and the panel follows it:{' '}
                      <code>{'{"entry": "minOperations", "cases": [{"name": "Case 1", "args": ["dog"], "expected": 1}]}'}</code>.
                      Cases added in this panel are kept in this browser only. Runs happen on the server
                      (Python / JavaScript / Java) with the visualization library stubbed out.
                    </div>
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
