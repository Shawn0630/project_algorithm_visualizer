import React from 'react';
import { connect } from 'react-redux';
import { TestApi, AiApi, PadTestsApi } from 'apis';
import { extension, aiPadKey, TESTCASES_APPLY_EVENT, VISUALIZE_CASE_EVENT } from 'common/util';
import { buildCaseVisualization } from 'common/visualizeCase';
import styles from './TestPanel.module.scss';

// LeetCode-style test cases for a code pad, docked under the editor
// as its own card, with three tabs: Testcase (edit + run cases),
// Test Result, and AI Test Cases (a dedicated generation session
// for this pad - ask for cases, then follow up to refine them).
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

// The page's problem statement for the AI session: the first
// Readme (or other Markdown doc, LICENSE excluded), length-capped.
function pageReadme(files) {
  const docs = (files || []).filter(f => /\.md$/i.test(f.name) && !/license/i.test(f.name));
  const readme = docs.find(f => /readme/i.test(f.name)) || docs[0];
  return readme ? String(readme.content || '').slice(0, 8000) : '';
}

// The part of a pad record that lives in the database.
const persistSlice = pad => ({
  entry: pad.entry,
  cases: pad.cases,
  seededFrom: pad.seededFrom,
  chat: pad.chat || [],
});

class TestPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      pads: loadStore(),
      tab: 'case',
      running: false,
      vizError: '',
      chatInput: '',
      chatSending: false,
      chatError: '',
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
      this.ingestCases(detail.entry, detail.cases, 'append');
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
              chat: Array.isArray(server.chat) ? server.chat : [],
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
    const chat = (stored && stored.chat) || [];
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
        chat,
        ts: stored ? stored.ts : 0,
      };
    }
    if (stored) return { ...stored, chat };
    return {
      entry: '',
      cases: [blankCase(1)],
      active: 0,
      open: false,
      results: null,
      runError: '',
      durationMs: null,
      seededFrom: null,
      chat,
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

  // ---- The dedicated test-case generation session (chat tab) ----

  sendChat(text) {
    const file = this.codeFile();
    const pad = this.pad();
    if (!file || !pad || this.state.chatSending) return;
    const instruction = (typeof text === 'string' ? text : this.state.chatInput).trim();
    if (!instruction) return;
    const history = (pad.chat || []).slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
    const userChat = [...(pad.chat || []), { role: 'user', text: instruction }].slice(-100);
    this.updatePad({ chat: userChat });
    this.setState({ chatInput: '', chatSending: true, chatError: '' });
    const currentCases = pad.cases.map(tc => {
      try {
        return { name: tc.name, args: JSON.parse(tc.argsText), expected: JSON.parse(tc.expectedText) };
      } catch (error) {
        return null;
      }
    }).filter(Boolean);
    let model;
    try {
      model = window.localStorage.getItem('av-ai-model-v1') || undefined;
    } catch (error) {
      model = undefined;
    }
    AiApi.testChat({
      language: extension(file.name),
      code: file.content,
      entry: pad.entry,
      context: pageReadme(this.props.current.files),
      currentCases,
      history,
      instruction,
      model,
    }).then(({ message, entry, mode, cases }) => {
      const assistantMsg = { role: 'assistant', text: message || '' };
      if (Array.isArray(cases) && cases.length) {
        assistantMsg.cases = cases;
        assistantMsg.mode = mode === 'replace' ? 'replace' : 'append';
        assistantMsg.entry = entry || '';
      }
      const current = this.pad();
      const chat = [...((current && current.chat) || []), assistantMsg].slice(-100);
      this.updatePad({ chat });
      this.setState({ chatSending: false });
    }).catch(error => {
      const data = error && error.response && error.response.data;
      this.setState({
        chatSending: false,
        chatError: (data && data.message) || 'The request failed. Is the server running?',
      });
    });
  }

  applyChatCases(index) {
    const pad = this.pad();
    if (!pad) return;
    const msg = (pad.chat || [])[index];
    if (!msg || !msg.cases || msg.applied) return;
    const chat = pad.chat.map((m, i) => i === index ? { ...m, applied: true } : m);
    this.updatePad({ chat }, () => this.ingestCases(msg.entry, msg.cases, msg.mode));
  }

  clearChat() {
    this.updatePad({ chat: [] });
    this.setState({ chatError: '' });
  }

  renderChat(pad) {
    const chat = pad.chat || [];
    return (
      <div>
        {
          chat.length ? (
            <div className={styles.chat_top}>
              <span className={styles.spacer}/>
              <button className={styles.chat_clear} onClick={() => this.clearChat()}>Clear chat</button>
            </div>
          ) : null
        }
        <div className={styles.chat_list}>
          {
            chat.length === 0 ? (
              <button className={styles.gen_btn} disabled={this.state.chatSending}
                      onClick={() => this.sendChat('Generate a good set of test cases for this code.')}>
                {this.state.chatSending ? 'Generating...' : 'Generate test cases'}
              </button>
            ) : chat.map((m, i) => (
              <div key={i} className={m.role === 'user' ? styles.chat_user : styles.chat_ai}>
                <div className={styles.chat_text}>{m.text}</div>
                {
                  m.cases ? (
                    <div className={styles.chat_cases}>
                      <div className={styles.chat_cases_head}>
                        {m.cases.length} case{m.cases.length === 1 ? '' : 's'} · {m.mode === 'replace' ? 'replaces the list' : 'new cases'}
                      </div>
                      <div className={styles.chat_cases_names}>
                        {m.cases.map(c => c.name).join(' · ')}
                      </div>
                      <button className={styles.gen_btn} disabled={m.applied}
                              onClick={() => this.applyChatCases(i)}>
                        {m.applied ? 'Applied ✓' : (m.mode === 'replace' ? 'Apply: replace all cases' : 'Apply: add these cases')}
                      </button>
                    </div>
                  ) : null
                }
              </div>
            ))
          }
          {this.state.chatSending && chat.length ? <div className={styles.hint}>Thinking...</div> : null}
        </div>
        {this.state.chatError ? <pre className={styles.error}>{this.state.chatError}</pre> : null}
        <div className={styles.chat_input_row}>
          <input className={styles.value_input} type="text" value={this.state.chatInput}
                 placeholder="Ask for cases, or follow up: add an empty-input case, make case 2 harder..."
                 onChange={e => this.setState({ chatInput: e.target.value })}
                 onKeyDown={e => { if (e.key === 'Enter') this.sendChat(); }}/>
          <button className={styles.run} disabled={this.state.chatSending} onClick={() => this.sendChat()}>
            {this.state.chatSending ? '...' : 'Send'}
          </button>
        </div>
      </div>
    );
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
      return <div className={styles.hint}>No run yet - press Run and the results show up here, one block per case.</div>;
    }
    const passed = pad.results.filter(r => r.pass).length;
    return (
      <div>
        {this.state.vizError ? <pre className={styles.error}>{this.state.vizError}</pre> : null}
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
              <button className={styles.viz_btn} onClick={() => this.visualizeCase(i)}>
                ▶ Visualize this case
              </button>
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
          <button className={`${styles.tab} ${tab === 'chat' ? styles.tab_active : ''}`}
                  title={pad.open && tab === 'chat' ? 'Click to collapse' : 'Click to expand'}
                  onClick={() => this.onTab('chat')}>
            ✦ AI Test Cases
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
                ) : tab === 'chat' ? this.renderChat(pad)
                : this.renderResults(pad)
              }
            </div>
          ) : null
        }
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }))(TestPanel);
