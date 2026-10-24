import React from 'react';
import { connect } from 'react-redux';
import { actions } from 'reducers';
import { AiApi, PadTestsApi } from 'apis';
import { extension, aiPadKey, AI_SESSION_DELETE_EVENT, TESTCASES_APPLY_EVENT } from 'common/util';
import { computeHunks, applyHunks } from './diff';
import styles from './AiAssistant.module.scss';

// AI assistant panel, docked as its own workspace pane next to the
// code pad (LeetCode-"Leet" style): the conversation fills the pane,
// the composer sits at the bottom. Every code pad (one file of one
// algorithm / scratch paper) owns a session; sessions are kept in
// memory and persisted to localStorage, so each pad's conversation is
// remembered across file switches and page reloads. On every request
// the AI sees the window context (page, file list, the current editor
// content) plus the session history.
// A code change comes back as a PROPOSAL first - it is written to the
// editor only when the user accepts it; rejecting it, or simply asking
// a follow-up, keeps the conversation going with the proposal folded
// into the history so the AI knows what happened to it.
//
// The pane has two tabs per pad: this Code AI, and Test Cases - the
// test-case generation chat that used to live inside the Testcase
// panel. Both AIs sit side by side here, one tab each, keyed by the
// same pad. The test chat's messages live in the pad's pad_tests
// database record (its `chat` field, merged partially server-side,
// so the Testcase panel's case edits and this chat never clobber
// each other); Apply dispatches TESTCASES_APPLY_EVENT and the
// Testcase panel drops the cases into its list and runs them.
const CODE_EXTS = ['js', 'java', 'py', 'cpp'];
const STORAGE_KEY = 'av-ai-sessions-v1';
const MODEL_KEY = 'av-ai-model-v1';
const TRACE_KEY = 'av-ai-trace-v1';

// The "Show AI process" toggle: when on, every AI reply grows an
// expandable process section (the server trace: model, attempts,
// pipeline steps, plus the full prompt and the raw response in
// collapsed sub-sections). Default off - the pane then looks
// exactly as it always did. Remembered across reloads.
function loadTracePref() {
  try {
    return window.localStorage.getItem(TRACE_KEY) === '1';
  } catch (error) {
    return false;
  }
}

// A trace duplicates the prompt (which embeds the whole file) and
// the raw reply, so when session storage has to prune, older
// messages keep their steps but shed those two heavy fields.
function slimTrace(trace) {
  if (!trace) return trace;
  return { ...trace, messages: null, rawResponse: null, slimmed: true };
}

function loadModelPref() {
  try {
    return window.localStorage.getItem(MODEL_KEY) || '';
  } catch (error) {
    return '';
  }
}

function loadSessions() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveSessions(sessions) {
  try {
    let data = sessions;
    if (JSON.stringify(data).length > 2000000) {
      // Prune: keep the most recent pads, and within each session keep
      // full code only on the latest AI message (older code mainly fed
      // follow-up context; the conversation text is what matters).
      data = {};
      Object.keys(sessions).slice(-6).forEach(key => {
        const session = sessions[key];
        data[key] = {
          ...session,
          messages: session.messages.map((message, i) =>
            i === session.messages.length - 1 ? message : { ...message, code: null, trace: slimTrace(message.trace) }),
        };
      });
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    // Storage full or unavailable: sessions simply stay in memory.
  }
}

const emptySession = () => ({ messages: [], pending: null });

// One-tap quick actions for the Code AI: each chip sends its text
// as the next user message of this pad's session, through exactly
// the same pipeline as typing it (the reply still arrives as a
// diff proposal the user reviews before anything is applied).
const QUICK_ACTIONS = [
  {
    label: 'Create empty template',
    instruction: 'Create an empty template for this problem in the current file: keep only the required tracer imports and the entry function or method signature for this problem (infer the signature from the problem statement and any test cases), with an empty body marked by a TODO comment. Do not implement the algorithm.',
  },
  {
    label: 'Solve the problem',
    instruction: 'Solve this problem: write a complete, correct solution in the current file that satisfies the problem statement, following all the tracer rules so it can be visualized, and cover the edge cases the statement implies.',
  },
  {
    label: 'Fix bugs',
    instruction: 'Find and fix the bugs in the current code. Keep the overall approach unless it is fundamentally wrong; in your explanation, list each bug you fixed and why it was wrong.',
  },
  {
    label: 'Give me hints',
    instruction: 'Give me hints for this problem instead of a solution: nudge me step by step - the key observation, which algorithm and data structure fit and why, and the edge cases to watch. Do not write the solution and do not change my code: return the current file unchanged.',
  },
  {
    label: 'Add visualization',
    instruction: 'Instrument the current code with this app\'s tracers so the algorithm can be visualized: create the appropriate tracers, record the key steps as the algorithm runs, set the layout root exactly once, and if the file only defines a class or functions, append a driver that runs a representative example. Keep the algorithm logic itself unchanged.',
  },
];

// Quick actions for the Test Cases tab, mirroring the code tab's
// row: each sends a preset instruction through the test-case
// chat. That chat's prompt already carries the pad's current
// case list, so Explain can walk the actual cases and the
// generation actions can avoid duplicating them.
const TEST_QUICK_ACTIONS = [
  {
    label: '✦ Generate test cases',
    instruction: 'Generate test cases for this code: cover the main scenarios from the problem statement plus the basic edge cases. If cases already exist, add the ones that are missing instead of repeating them.',
  },
  {
    label: 'Explain test cases',
    instruction: 'Explain the current test cases one by one: for each case, the input it feeds the entry, the expected output and why that is the correct result, and which behavior, branch or edge it covers. Finish with any important scenario that is not covered yet. Do not generate or change any test cases.',
  },
  {
    label: 'Add edge cases',
    instruction: 'Add test cases for edge and boundary conditions the current cases do not already cover: empty or minimal inputs, a single element, duplicates, zero or negative values where the problem allows them, already-sorted and reverse-sorted inputs, and large inputs where relevant. Do not duplicate existing cases.',
  },
];

// Quick actions for a Markdown note pad: same idea as the code
// tab's row, but the instructions work on the note - the server
// runs these through the markdown mode of /assist, with the
// page's documents (the problem statement) as context.
const MD_QUICK_ACTIONS = [
  {
    label: 'Summarize the problem',
    instruction: 'Add a summary section to this note covering the problem statement from the page context: what is being asked, the input and output, the key constraints, and one worked example. Keep everything already in the note and return the complete file.',
  },
  {
    label: 'Draft the approach',
    instruction: 'Add an approach section to this note: the key observation, the algorithm and data structure to use, why it works, and the time and space complexity, all based on the problem statement in the page context. Keep everything already in the note and return the complete file.',
  },
  {
    label: 'Improve this note',
    instruction: 'Improve this note: fix the Markdown formatting, organize it under clear headings, tighten the wording, and keep every fact, example and code snippet. Return the complete file.',
  },
];

// The page's problem statement for the test-case chat: the first
// Readme (or other Markdown doc, LICENSE excluded), length-capped.
function pageReadme(files) {
  const docs = (files || []).filter(f => /\.md$/i.test(f.name) && !/license/i.test(f.name));
  const readme = docs.find(f => /readme/i.test(f.name)) || docs[0];
  return readme ? String(readme.content || '').slice(0, 8000) : '';
}

class AiAssistant extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sessions: loadSessions(), instruction: '', busy: false, error: '',
      models: [], selectedModel: loadModelPref(),
      showTrace: loadTracePref(),
      activeTab: 'code',
      testChats: {}, testInput: '', testSending: false, testError: '',
    };
    this.logRef = React.createRef();
    this.testLoadedKeys = new Set();
    this.testPersistTimers = {};
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.sessions !== this.state.sessions) {
      saveSessions(this.state.sessions);
      if (this.logRef.current) {
        this.logRef.current.scrollTop = this.logRef.current.scrollHeight;
      }
    }
    if (prevState.testChats !== this.state.testChats && this.logRef.current) {
      this.logRef.current.scrollTop = this.logRef.current.scrollHeight;
    }
    // The Test Cases tab reads its chat from the pad_tests record;
    // load it the first time a pad's tab is shown.
    if (this.state.activeTab === 'tests') this.ensureTestChat();
  }

  componentDidMount() {
    // When a code file is deleted (tab close or the editor's Delete
    // File button), its AI session is deleted with it.
    this.handleSessionDelete = event => this.dropSession(event.detail);
    window.addEventListener(AI_SESSION_DELETE_EVENT, this.handleSessionDelete);
    this.loadModels();
  }

  // The model picker: the server reports which models the API key
  // can use; the choice is global (not per pad), remembered across
  // reloads, and sent with every request. The .env fallback model
  // still applies underneath the picked one.
  loadModels() {
    AiApi.models().then(({ models, configured }) => {
      const list = Array.isArray(models) ? models : [];
      this.setState(prev => {
        let selected = prev.selectedModel;
        if (!selected || (list.length && !list.includes(selected))) {
          selected = (configured && configured.model) || list[0] || '';
        }
        return { models: list, selectedModel: selected };
      });
    }).catch(() => {
      // No list (server down / LLM unconfigured): the picker stays
      // hidden and requests behave exactly as before.
    });
  }

  pickModel(model) {
    this.setState({ selectedModel: model });
    try {
      window.localStorage.setItem(MODEL_KEY, model);
    } catch (error) {
      // Storage unavailable: the choice still applies to this page.
    }
  }

  toggleTrace() {
    const next = !this.state.showTrace;
    this.setState({ showTrace: next });
    try {
      window.localStorage.setItem(TRACE_KEY, next ? '1' : '0');
    } catch (error) {
      // Storage unavailable: the toggle still applies to this page.
    }
  }

  // The expandable "process" section under an AI reply: the
  // server trace's headline (model, time, attempts) and its
  // pipeline steps in order; the full prompt and the raw model
  // response sit in their own collapsed sub-sections because both
  // can be very long. Renders nothing when the toggle is off or
  // the reply carries no trace (older replies, endpoints without
  // one).
  renderTrace(trace) {
    if (!this.state.showTrace || !trace) return null;
    const steps = Array.isArray(trace.steps) ? trace.steps : [];
    const marks = { ok: '✓', skipped: '–', triggered: '⚠', error: '✗', info: 'ℹ' };
    return (
      <details className={styles.trace}>
        <summary>
          过程 · {trace.model || 'unknown model'}{trace.usedFallback ? ' (fallback)' : ''}
          {typeof trace.durationMs === 'number' ? ` · ${(trace.durationMs / 1000).toFixed(1)}s` : ''}
          {typeof trace.attempts === 'number' ? ` · ${trace.attempts} attempt(s)${trace.retries ? ` · ${trace.retries} retries` : ''}` : ''}
        </summary>
        <div className={styles.trace_steps}>
          {
            steps.map((step, i) => (
              <div key={i} className={styles.trace_step}>
                <span className={styles.trace_step_name}>{marks[step.status] || '·'} {step.name}</span>
                {typeof step.attempts === 'number' ? <span className={styles.trace_step_meta}>{step.attempts} attempt(s)</span> : null}
                {typeof step.durationMs === 'number' ? <span className={styles.trace_step_meta}>{step.durationMs}ms</span> : null}
                {step.detail ? <div className={styles.trace_detail}>{step.detail}</div> : null}
              </div>
            ))
          }
        </div>
        {
          Array.isArray(trace.messages) && trace.messages.length ? (
            <details className={styles.trace_sub}>
              <summary>Prompt sent to the model ({trace.messages.length} messages)</summary>
              {
                trace.messages.map((message, i) => (
                  <div key={i} className={styles.trace_msg}>
                    <div className={styles.trace_role}>{message.role}</div>
                    <pre className={styles.code}>{typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 1)}</pre>
                  </div>
                ))
              }
            </details>
          ) : null
        }
        {
          trace.rawResponse ? (
            <details className={styles.trace_sub}>
              <summary>Raw model response</summary>
              <pre className={styles.code}>{trace.rawResponse}</pre>
            </details>
          ) : null
        }
        {trace.slimmed ? <div className={styles.trace_detail}>(Older reply - its prompt and raw response were dropped to save storage space; the steps above are complete.)</div> : null}
      </details>
    );
  }

  componentWillUnmount() {
    window.removeEventListener(AI_SESSION_DELETE_EVENT, this.handleSessionDelete);
  }

  dropSession(key) {
    if (!key || !(key in this.state.sessions)) return;
    this.setState(prev => {
      const sessions = { ...prev.sessions };
      delete sessions[key];
      return { sessions };
    });
  }

  padKey() {
    const { editingFile } = this.props.current;
    return editingFile ? aiPadKey(this.props.current, editingFile.name) : null;
  }

  session() {
    const key = this.padKey();
    return (key && this.state.sessions[key]) || emptySession();
  }

  updateSession(patch, key = this.padKey()) {
    if (!key) return;
    this.setState(prev => ({
      sessions: {
        ...prev.sessions,
        [key]: { ...(prev.sessions[key] || emptySession()), ...patch },
      },
    }));
  }

  sessionFor(key) {
    return (key && this.state.sessions[key]) || emptySession();
  }

  // Serializes the session (plus a still-pending proposal) into chat
  // turns for the API, so the AI knows what it proposed before and
  // whether the user applied it.
  buildHistory(session) {
    const turns = [];
    const noteFor = message => message.superseded
      ? 'superseded by a later message and never applied'
      : message.applied
        ? (message.partial ? 'applied to the editor in part (the user kept only some hunks of the proposal)' : 'applied to the editor by the user')
        : 'not applied by the user';
    const aiTurn = (text, code, note, testCases) => ({
      role: 'assistant',
      content: (code ? `${text}\n\n\`\`\`\n${code}\n\`\`\`\n(${note})` : `${text}\n(${note})`)
        + (testCases && testCases.length ? `\nTest cases returned with that reply: ${JSON.stringify(testCases)}` : ''),
    });
    session.messages.forEach(message => {
      if (message.from === 'user') {
        turns.push({ role: 'user', content: message.text });
      } else {
        turns.push(aiTurn(message.text, message.code, noteFor(message), message.testCases));
      }
    });
    if (session.pending) {
      turns.push(aiTurn(session.pending.explanation, session.pending.code, 'proposed; the user has not decided yet', session.pending.testCases));
    }
    return turns;
  }

  send(instruction) {
    const { editingFile, titles, files } = this.props.current;
    const text = (instruction !== undefined ? instruction : this.state.instruction).trim();
    if (!editingFile || !text || this.state.busy) return;
    // The reply is written back to the pad that asked, even if the user
    // switches files while waiting.
    const key = this.padKey();

    // Fold a still-pending proposal into the history as superseded,
    // then start the new turn.
    const session = this.session();
    const messages = [...session.messages];
    if (session.pending) {
      messages.push({
        from: 'ai', text: session.pending.explanation, code: session.pending.code, applied: false, superseded: true,
        testCases: session.pending.testCases || null, testEntry: session.pending.testEntry || '', casesApplied: !!session.pending.casesApplied,
        trace: session.pending.trace || null,
      });
    }
    messages.push({ from: 'user', text });
    const history = this.buildHistory({ messages: messages.slice(0, -1), pending: null });
    this.updateSession({ messages, pending: null }, key);
    this.setState({ busy: true, error: '', instruction: '' });
    const sentCode = editingFile.content;

    AiApi.assist({
      code: editingFile.content,
      language: extension(editingFile.name),
      instruction: text,
      model: this.state.selectedModel || undefined,
      history,
      context: {
        title: (titles || []).join(' / '),
        fileName: editingFile.name,
        files: (files || []).map(file => file.name),
        // The page's Markdown document (e.g. a LeetCode problem's
        // Readme.md) rides along as context, so the AI knows the
        // problem statement behind the code it is asked to work on.
        readme: (() => {
          const mdFiles = (files || []).filter(file => extension(file.name) === 'md');
          return mdFiles.length ? {
            name: mdFiles.map(file => file.name).join(', '),
            content: mdFiles.map(file => file.content).join('\n\n'),
          } : undefined;
        })(),
      },
    }).then(({ code, explanation, changed, syntax, partialSuspected, testCases, entry, runError, apiError, trace }) => {
      this.setState({ busy: false });
      // The third kind of AI result: a set of test cases riding
      // along with the reply. It is offered as its own apply action
      // (into this pad's Testcase panel), independent of whether
      // the reply also changed code.
      const cases = Array.isArray(testCases) && testCases.length ? testCases : null;
      if (changed && code) {
        // The proposal is consumed into a line diff against the code
        // that was sent; the user accepts hunks, not a blind replace.
        const hunks = computeHunks(sentCode, code).map(hunk => ({ ...hunk, accepted: true }));
        this.updateSession({
          pending: {
            code, explanation: explanation || '', syntax: syntax || null, partialSuspected: !!partialSuspected, hunks,
            runError: runError || null,
            apiError: apiError || null,
            trace: trace || null,
            testCases: cases, testEntry: entry || '', casesApplied: false,
          },
        }, key);
      } else {
        const current = this.sessionFor(key);
        this.updateSession({
          messages: [...current.messages, {
            from: 'ai', text: explanation || '(The AI returned no explanation.)', code: null, applied: false,
            testCases: cases, testEntry: entry || '', casesApplied: false,
            trace: trace || null,
          }],
        }, key);
      }
    }).catch(error => {
      const data = error && error.response && error.response.data;
      this.setState({
        busy: false,
        error: (data && data.message) || 'AI request failed. Is the server running?',
      });
    });
  }

  toggleHunk(hunkId) {
    const session = this.session();
    if (!session.pending) return;
    this.updateSession({
      pending: {
        ...session.pending,
        hunks: session.pending.hunks.map(hunk => hunk.id === hunkId ? { ...hunk, accepted: !hunk.accepted } : hunk),
      },
    });
  }

  // Applies only the accepted hunks onto the CURRENT editor content.
  applySelected() {
    const { editingFile } = this.props.current;
    const session = this.session();
    if (!editingFile || !session.pending) return;
    const accepted = session.pending.hunks.filter(hunk => hunk.accepted);
    if (!accepted.length) return;
    const result = applyHunks(editingFile.content, accepted);
    if (result.applied === 0) {
      this.setState({ error: 'The original text of the selected hunks was edited in the editor, so they can no longer be located. Discard the proposal and ask again.' });
      return;
    }
    if (result.text !== editingFile.content) {
      this.props.modifyFile(editingFile, result.text);
    }
    this.updateSession({
      messages: [...session.messages, {
        from: 'ai',
        text: session.pending.explanation,
        code: result.text,
        applied: true,
        partial: accepted.length < session.pending.hunks.length || result.failed.length > 0,
        testCases: session.pending.testCases || null,
        testEntry: session.pending.testEntry || '',
        casesApplied: !!session.pending.casesApplied,
        trace: session.pending.trace || null,
      }],
      pending: null,
    });
  }

  rejectProposal() {
    const session = this.session();
    if (!session.pending) return;
    this.updateSession({
      messages: [...session.messages, {
        from: 'ai', text: session.pending.explanation, code: session.pending.code, applied: false,
        testCases: session.pending.testCases || null,
        testEntry: session.pending.testEntry || '',
        casesApplied: !!session.pending.casesApplied,
        trace: session.pending.trace || null,
      }],
      pending: null,
    });
  }

  // Hands a reply's test cases to this pad's Testcase panel, which
  // ingests them like its own Generate output (and runs them).
  applyTestCases(testCases, entry) {
    const key = this.padKey();
    if (!key || !testCases || !testCases.length) return;
    window.dispatchEvent(new CustomEvent(TESTCASES_APPLY_EVENT, {
      detail: { key, entry: entry || '', cases: testCases },
    }));
  }

  applyMessageCases(index) {
    const session = this.session();
    const message = session.messages[index];
    if (!message || !message.testCases) return;
    this.applyTestCases(message.testCases, message.testEntry);
    this.updateSession({
      messages: session.messages.map((m, i) => i === index ? { ...m, casesApplied: true } : m),
    });
  }

  applyPendingCases() {
    const session = this.session();
    if (!session.pending || !session.pending.testCases) return;
    this.applyTestCases(session.pending.testCases, session.pending.testEntry);
    this.updateSession({ pending: { ...session.pending, casesApplied: true } });
  }

  // ---- Test Cases tab: the per-pad generation chat ----
  // Messages are {role: 'user'|'assistant', text, cases?, mode?,
  // entry?, applied?}; they persist in the pad_tests record's
  // chat field (partial merge server-side).

  testChat() {
    const key = this.padKey();
    return (key && this.state.testChats[key]) || [];
  }

  ensureTestChat() {
    const key = this.padKey();
    if (!key || this.testLoadedKeys.has(key)) return;
    this.testLoadedKeys.add(key);
    PadTestsApi.list().then(({ entries }) => {
      const record = entries ? entries[key] : null;
      this.setState(prev => prev.testChats[key]
        ? prev
        : { testChats: { ...prev.testChats, [key]: (record && Array.isArray(record.chat)) ? record.chat : [] } });
    }).catch(() => {
      this.setState(prev => prev.testChats[key]
        ? prev
        : { testChats: { ...prev.testChats, [key]: [] } });
    });
  }

  updateTestChat(messages, key = this.padKey()) {
    if (!key) return;
    this.setState(prev => ({ testChats: { ...prev.testChats, [key]: messages } }));
    window.clearTimeout(this.testPersistTimers[key]);
    this.testPersistTimers[key] = window.setTimeout(() => {
      PadTestsApi.put({ key, chat: messages }).catch(() => {});
    }, 500);
  }

  sendTestChat(preset) {
    const { editingFile, files } = this.props.current;
    const key = this.padKey();
    if (!editingFile || !key) return;
    const instruction = (preset !== undefined ? preset : this.state.testInput).trim();
    if (!instruction || this.state.testSending) return;
    const prior = this.testChat();
    const history = prior.slice(-20).map(m => ({ role: m.role, content: m.text }));
    const working = [...prior, { role: 'user', text: instruction }].slice(-100);
    this.updateTestChat(working);
    this.setState({ testInput: '', testSending: true, testError: '' });
    // The pad's current entry + cases live in the Testcase panel's
    // record; re-read it fresh so the AI refines what the panel
    // actually shows, not a stale copy.
    const freshRecord = PadTestsApi.list()
      .then(({ entries }) => (entries ? entries[key] : null) || null)
      .catch(() => null);
    freshRecord.then(record => {
      const currentCases = [];
      for (const tc of (record && record.cases) || []) {
        try {
          currentCases.push({ name: tc.name, args: JSON.parse(tc.argsText), expected: JSON.parse(tc.expectedText) });
        } catch (error) {
          // Unparseable editor text: leave that case out.
        }
      }
      return AiApi.testChat({
        language: extension(editingFile.name),
        code: editingFile.content,
        entry: (record && record.entry) || '',
        context: pageReadme(files),
        currentCases,
        history,
        instruction,
        model: this.state.selectedModel || undefined,
      });
    }).then(({ message, entry, mode, cases, trace }) => {
      const next = [...working, {
        role: 'assistant',
        text: message || '',
        cases: (cases && cases.length) ? cases : undefined,
        mode: mode === 'replace' ? 'replace' : 'append',
        entry: entry || '',
        applied: false,
        trace: trace || null,
      }].slice(-100);
      this.updateTestChat(next, key);
      this.setState({ testSending: false });
    }).catch(error => {
      this.setState({ testSending: false, testError: (error && error.message) || 'The AI request failed.' });
    });
  }

  applyTestChatCases(index) {
    const messages = this.testChat();
    const message = messages[index];
    if (!message || !message.cases) return;
    const key = this.padKey();
    window.dispatchEvent(new CustomEvent(TESTCASES_APPLY_EVENT, {
      detail: { key, entry: message.entry || '', mode: message.mode || 'append', cases: message.cases },
    }));
    this.updateTestChat(messages.map((m, i) => i === index ? { ...m, applied: true } : m));
  }

  clearTestChat() {
    this.updateTestChat([]);
  }

  renderTestChat() {
    const messages = this.testChat();
    const { testSending } = this.state;
    return (
      <React.Fragment>
        {
          messages.map((message, i) => (
            message.role === 'user' ? (
              <div key={i} className={styles.user_message}>{message.text}</div>
            ) : (
              <div key={i} className={styles.ai_message}>
                <div className={styles.text}>{message.text}</div>
                {
                  message.cases ? (
                    <div className={styles.test_card}>
                      <div className={styles.test_card_title}>
                        {message.cases.length} test case(s) - {message.mode === 'replace' ? 'replaces the panel list' : 'adds to the panel list'}
                      </div>
                      {
                        message.cases.map((tc, j) => (
                          <div key={j} className={styles.test_case_line}>
                            <b>{tc.name || `Case ${j + 1}`}</b>
                            <span> args: {JSON.stringify(tc.args)}</span>
                            <span> → {JSON.stringify(tc.expected)}</span>
                          </div>
                        ))
                      }
                      <button className={styles.chip} disabled={message.applied}
                              onClick={() => this.applyTestChatCases(i)}>
                        {message.applied ? '✓ Added to the Testcase panel' : 'Add to Testcase panel'}
                      </button>
                    </div>
                  ) : null
                }
                {this.renderTrace(message.trace)}
              </div>
            )
          ))
        }
        {testSending ? <div className={styles.ai_message}>Thinking...</div> : null}
      </React.Fragment>
    );
  }

  // The card for a reply's test cases: the cases themselves plus
  // the apply action. Scratch papers have no Testcase panel, so
  // their card is read-only.
  renderCasesCard(testCases, entry, applied, onApply) {
    const key = this.padKey();
    const isScratch = !!key && key.startsWith('scratch:');
    return (
      <div className={styles.cases_card}>
        <div className={styles.cases_title}>
          Test cases ({testCases.length}){entry ? ` · entry: ${entry}` : ''}
        </div>
        {
          testCases.map((tc, i) => (
            <div key={i} className={styles.case_line}>
              <span className={styles.case_name}>{tc.name}</span>
              <code>{JSON.stringify(tc.args)} → {JSON.stringify(tc.expected)}</code>
            </div>
          ))
        }
        {
          isScratch ? (
            <div className={styles.status}>Scratch papers have no Testcase panel.</div>
          ) : (
            <button className={styles.chip} disabled={applied} onClick={onApply}>
              {applied ? '✓ Added to the Testcase panel' : 'Add to Testcase panel'}
            </button>
          )
        }
      </div>
    );
  }

  sendFixSyntax() {
    const session = this.session();
    if (!session.pending || !session.pending.syntax || session.pending.syntax.ok) return;
    this.send(`The code in your previous reply failed the syntax check with this error:\n${session.pending.syntax.error}\nFix it and return the complete file again, keeping everything else unchanged.`);
  }

  sendFixRun() {
    const session = this.session();
    if (!session.pending || !session.pending.runError) return;
    this.send(`The code in your previous reply was run and did not produce a working visualization:\n${session.pending.runError}\nFix it and return the complete file again: import the tracer library, define every tracer variable you use, set the layout root exactly once, and if the file only defines a class or functions, append a driver section that creates the tracers and actually calls the code.`);
  }

  sendFixApi() {
    const session = this.session();
    if (!session.pending || !session.pending.apiError) return;
    this.send(`The code in your previous reply misuses this app's tracer library - the API check flagged these problems:\n${session.pending.apiError}\nFix them and return the complete file again, using only the methods in the reference, each with the argument count the reference shows for that exact tracer class.`);
  }

  clearSession() {
    this.updateSession(emptySession());
  }

  renderPending(session) {
    const pending = session.pending;
    const acceptedCount = pending.hunks.filter(hunk => hunk.accepted).length;
    return (
      <div className={styles.pending}>
        {pending.explanation ? <div className={styles.text}>{pending.explanation}</div> : null}
        {
          pending.testCases ? this.renderCasesCard(pending.testCases, pending.testEntry, pending.casesApplied, () => this.applyPendingCases()) : null
        }
        {
          pending.partialSuspected ? (
            <div className={styles.syntax_bad}>
              <div>⚠ The code the AI returned looks incomplete (it was automatically asked to resend once and still failed the completeness check). Large deletions in the diff are probably its elisions - review carefully before applying.</div>
            </div>
          ) : null
        }
        {
          pending.syntax ? (
            pending.syntax.ok ? (
              <div className={styles.syntax_ok}>✓ Syntax check passed</div>
            ) : (
              <div className={styles.syntax_bad}>
                <div>⚠ Syntax check failed - review before applying, or let the AI fix it:</div>
                <pre className={styles.code}>{pending.syntax.error}</pre>
                <button className={styles.chip} onClick={() => this.sendFixSyntax()}>Fix this with AI</button>
              </div>
            )
          ) : null
        }
        {
          pending.apiError ? (
            <div className={styles.syntax_bad}>
              <div>⚠ API check failed - the tracer-library check flagged these problems:</div>
              <pre className={styles.code}>{pending.apiError}</pre>
              <button className={styles.chip} onClick={() => this.sendFixApi()}>Fix this with AI</button>
            </div>
          ) : null
        }
        {
          pending.runError ? (
            <div className={styles.syntax_bad}>
              <div>⚠ Visualization run failed - this code was actually run and produced no working visualization. Review before applying, or let the AI fix it:</div>
              <pre className={styles.code}>{pending.runError}</pre>
              <button className={styles.chip} onClick={() => this.sendFixRun()}>Fix this with AI</button>
            </div>
          ) : null
        }
        {
          pending.hunks.map(hunk => (
            <div key={hunk.id} className={`${styles.hunk} ${hunk.accepted ? '' : styles.hunk_dropped}`}>
              <div className={styles.hunk_header}>
                <span>Change {hunk.id + 1}</span>
                <button className={styles.chip} onClick={() => this.toggleHunk(hunk.id)}>
                  {hunk.accepted ? '✓ Keep this change' : 'Dropped (click to restore)'}
                </button>
              </div>
              <div className={styles.hunk_lines}>
                {
                  hunk.lines.map((line, i) => (
                    <div key={i} className={styles[`line_${line.type}`]}>
                      {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}{line.line}
                    </div>
                  ))
                }
              </div>
            </div>
          ))
        }
        <div className={styles.row}>
          <button className={styles.accept} disabled={!acceptedCount} onClick={() => this.applySelected()}>
            Apply selected changes ({acceptedCount}/{pending.hunks.length})
          </button>
          <button className={styles.chip} onClick={() => this.rejectProposal()}>✗ Discard all</button>
          <span className={styles.status}>or keep asking below</span>
        </div>
        {this.renderTrace(pending.trace)}
      </div>
    );
  }

  renderCodeCard(message, statusText) {
    return (
      <div>
        {message.text ? <div className={styles.text}>{message.text}</div> : null}
        <pre className={styles.code}>{message.code}</pre>
        <div className={styles.status}>{statusText}</div>
      </div>
    );
  }

  render() {
    const { editingFile } = this.props.current;
    const isCode = !!editingFile && CODE_EXTS.includes(extension(editingFile.name));
    const isMd = !!editingFile && extension(editingFile.name) === 'md';
    const { instruction, busy, error, activeTab, testInput, testSending, testError } = this.state;
    const session = this.session();
    const hasSession = session.messages.length > 0 || session.pending;
    // A Markdown pad has a note session only - the test-case
    // chat needs a code file, so its tab is hidden for notes.
    const inTests = activeTab === 'tests' && !isMd;
    const chat = this.testChat();

    return (
      <div className={styles.ai_assistant}>
        <div className={styles.row}>
          <span className={styles.title}>AI Assistant</span>
          {inTests ? (
            chat.length ? (
              <button className={styles.chip} disabled={testSending} onClick={() => this.clearTestChat()}>
                Clear chat
              </button>
            ) : null
          ) : hasSession ? (
            <button className={styles.chip} disabled={busy} onClick={() => this.clearSession()}>
              Clear session
            </button>
          ) : null}
        </div>
        <div className={styles.pad_name}>
          {editingFile ? `Session for ${editingFile.name}` : 'No file open'}
        </div>
        {
          this.state.models.length ? (
            <div className={styles.model_row}>
              <span>Model</span>
              <select className={styles.model_select} value={this.state.selectedModel} disabled={busy || testSending}
                      onChange={e => this.pickModel(e.target.value)}>
                {this.state.models.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            </div>
          ) : null
        }
        <div className={styles.trace_toggle_row}>
          <label className={styles.trace_toggle}>
            <input type="checkbox" checked={this.state.showTrace} onChange={() => this.toggleTrace()}/>
            显示 AI 过程
          </label>
          <span className={styles.trace_toggle_hint}>model, prompt, raw reply and pipeline steps under each reply</span>
        </div>
        <div className={styles.tab_row}>
          {
            isMd ? (
              <button className={`${styles.ai_tab} ${styles.ai_tab_active}`}>
                ✎ Note AI
              </button>
            ) : (
              <React.Fragment>
                <button className={`${styles.ai_tab} ${!inTests ? styles.ai_tab_active : ''}`}
                        onClick={() => this.setState({ activeTab: 'code' })}>
                  Code AI
                </button>
                <button className={`${styles.ai_tab} ${inTests ? styles.ai_tab_active : ''}`}
                        onClick={() => this.setState({ activeTab: 'tests' })}>
                  ✦ Test Cases
                </button>
              </React.Fragment>
            )
          }
        </div>
        <div className={styles.log} ref={this.logRef}>
          {
            !isCode && !isMd ? (
              <div className={styles.empty_state}>
                The current file is not a code or Markdown file. Switch to a code file (.js / .java / .py / .cpp) or a Markdown note (.md) to see its AI session here.
              </div>
            ) : inTests ? this.renderTestChat() : !hasSession && !busy ? null : (
              <React.Fragment>
                {
                  session.messages.map((message, i) => (
                    message.from === 'user' ? (
                      <div key={i} className={styles.user_message}>{message.text}</div>
                    ) : (
                      <div key={i} className={styles.ai_message}>
                        {
                          message.code
                            ? this.renderCodeCard(message, message.applied ? (message.partial ? '✓ Partially applied' : '✓ Applied to the editor') : 'Not applied')
                            : <div className={styles.text}>{message.text}</div>
                        }
                        {
                          message.testCases
                            ? this.renderCasesCard(message.testCases, message.testEntry, message.casesApplied, () => this.applyMessageCases(i))
                            : null
                        }
                        {this.renderTrace(message.trace)}
                      </div>
                    )
                  ))
                }
                {session.pending ? this.renderPending(session) : null}
                {busy ? <div className={styles.ai_message}>Thinking...</div> : null}
              </React.Fragment>
            )
          }
        </div>
        {
          inTests ? (
            <React.Fragment>
              <div className={styles.quick_row}>
                {TEST_QUICK_ACTIONS.map(action => (
                  <button key={action.label} className={styles.chip} disabled={testSending || !isCode}
                          onClick={() => this.sendTestChat(action.instruction)}>
                    {action.label}
                  </button>
                ))}
              </div>
              <div className={styles.row}>
                <input className={styles.input} type="text" value={testInput} disabled={!isCode}
                       placeholder="Ask for test cases, e.g. add an empty-array case"
                       onChange={e => this.setState({ testInput: e.target.value })}
                       onKeyDown={e => {
                         if (e.key === 'Enter') this.sendTestChat();
                       }}/>
                <button className={styles.send} disabled={testSending || !isCode || !testInput.trim()} onClick={() => this.sendTestChat()}>
                  {testSending ? 'Working...' : 'Send'}
                </button>
              </div>
              {testError ? <div className={styles.error}>{testError}</div> : null}
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div className={styles.quick_row}>
                {(isMd ? MD_QUICK_ACTIONS : QUICK_ACTIONS).map(action => (
                  <button key={action.label} className={styles.chip} disabled={busy || (!isCode && !isMd)}
                          onClick={() => this.send(action.instruction)}>
                    {action.label}
                  </button>
                ))}
              </div>
              <div className={styles.row}>
                <input className={styles.input} type="text" value={instruction} disabled={!isCode && !isMd}
                       placeholder={isMd
                         ? 'Tell the AI what to do with this note, e.g. add a summary of the problem'
                         : 'Tell the AI what to do with this code, e.g. turn bubble sort into quicksort'}
                       onChange={e => this.setState({ instruction: e.target.value })}
                       onKeyDown={e => {
                         if (e.key === 'Enter') this.send();
                       }}/>
                <button className={styles.send} disabled={busy || (!isCode && !isMd) || !instruction.trim()} onClick={() => this.send()}>
                  {busy ? 'Working...' : 'Send'}
                </button>
              </div>
              {error ? <div className={styles.error}>{error}</div> : null}
            </React.Fragment>
          )
        }
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }), actions)(AiAssistant);
