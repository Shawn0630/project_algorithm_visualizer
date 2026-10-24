import React from 'react';
import { connect } from 'react-redux';
import { actions } from 'reducers';
import { AiApi } from 'apis';
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
// The pane is this Code AI only. (A separate test-case generation
// chat used to live here as a second tab; it was removed - the
// Code AI itself can still return test cases with a reply, and
// those are offered on the reply card with an apply action into
// the pad's Testcase panel via TESTCASES_APPLY_EVENT.)
const CODE_EXTS = ['js', 'java', 'py', 'cpp'];
const STORAGE_KEY = 'av-ai-sessions-v1';
const MODEL_KEY = 'av-ai-model-v1';

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
            i === session.messages.length - 1 ? message : { ...message, code: null }),
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
    label: 'Add visualization',
    instruction: 'Instrument the current code with this app\'s tracers so the algorithm can be visualized: create the appropriate tracers, record the key steps as the algorithm runs, set the layout root exactly once, and if the file only defines a class or functions, append a driver that runs a representative example. Keep the algorithm logic itself unchanged.',
  },
];

class AiAssistant extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sessions: loadSessions(), instruction: '', busy: false, error: '',
      models: [], selectedModel: loadModelPref(),
    };
    this.logRef = React.createRef();
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.sessions !== this.state.sessions) {
      saveSessions(this.state.sessions);
      if (this.logRef.current) {
        this.logRef.current.scrollTop = this.logRef.current.scrollHeight;
      }
    }
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
    }).then(({ code, explanation, changed, syntax, partialSuspected, testCases, entry, runError, apiError }) => {
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
            testCases: cases, testEntry: entry || '', casesApplied: false,
          },
        }, key);
      } else {
        const current = this.sessionFor(key);
        this.updateSession({
          messages: [...current.messages, {
            from: 'ai', text: explanation || '(The AI returned no explanation.)', code: null, applied: false,
            testCases: cases, testEntry: entry || '', casesApplied: false,
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
    const { instruction, busy, error } = this.state;
    const session = this.session();
    const hasSession = session.messages.length > 0 || session.pending;

    return (
      <div className={styles.ai_assistant}>
        <div className={styles.row}>
          <span className={styles.title}>AI Assistant</span>
          {hasSession ? (
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
              <select className={styles.model_select} value={this.state.selectedModel} disabled={busy}
                      onChange={e => this.pickModel(e.target.value)}>
                {this.state.models.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            </div>
          ) : null
        }
        <div className={styles.log} ref={this.logRef}>
          {
            !isCode ? (
              <div className={styles.empty_state}>
                The current file is not a code file. Switch to a code file (.js / .java / .py / .cpp) to see its AI session here.
              </div>
            ) : !hasSession && !busy ? (
              <div className={styles.empty_state}>
                This is the AI session for {editingFile.name}. Each file has its own session, and sessions are remembered. Ask the AI to write code, add tracers, explain, or find bugs - its changes arrive as a diff proposal first, and only the hunks you keep are applied to the editor. Or start with a quick action below.
              </div>
            ) : (
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
        <div className={styles.quick_row}>
          {QUICK_ACTIONS.map(action => (
            <button key={action.label} className={styles.chip} disabled={busy || !isCode}
                    onClick={() => this.send(action.instruction)}>
              {action.label}
            </button>
          ))}
        </div>
        <div className={styles.row}>
          <input className={styles.input} type="text" value={instruction} disabled={!isCode}
                 placeholder="Tell the AI what to do with this code, e.g. turn bubble sort into quicksort"
                 onChange={e => this.setState({ instruction: e.target.value })}
                 onKeyDown={e => {
                   if (e.key === 'Enter') this.send();
                 }}/>
          <button className={styles.send} disabled={busy || !isCode || !instruction.trim()} onClick={() => this.send()}>
            {busy ? 'Working...' : 'Send'}
          </button>
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }), actions)(AiAssistant);
