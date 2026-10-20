import React from 'react';
import { connect } from 'react-redux';
import { actions } from 'reducers';
import { AiApi } from 'apis';
import { extension, aiPadKey, AI_SESSION_DELETE_EVENT } from 'common/util';
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
const CODE_EXTS = ['js', 'java', 'py', 'cpp'];
const STORAGE_KEY = 'av-ai-sessions-v1';

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

const PRESETS = [
  {
    label: '加 Tracer',
    instruction: '给这段代码加上 tracer 可视化：用合适的 Tracer 记录关键数据变化，每一步后调用 delay，并设置好 Layout 根节点。保持原有算法逻辑不变。',
  },
  {
    label: '解释代码',
    instruction: '解释这段代码的算法思路、关键步骤和复杂度。不要修改代码，code 字段原样返回，解释写在 explanation 里。',
  },
  {
    label: '找问题',
    instruction: '检查这段代码的 bug 和边界问题，返回修复后的完整代码，并在 explanation 里说明发现了什么问题、改了哪里。',
  },
];

const emptySession = () => ({ messages: [], pending: null });

class AiAssistant extends React.Component {
  constructor(props) {
    super(props);
    this.state = { sessions: loadSessions(), instruction: '', busy: false, error: '' };
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
      ? '这份提案被后续对话取代，未应用'
      : message.applied
        ? (message.partial ? '这份代码是提案被部分应用后的编辑器结果' : '这份代码已被用户应用到编辑器')
        : '这份代码未被用户采用';
    const aiTurn = (text, code, note) => ({
      role: 'assistant',
      content: code ? `${text}\n\n\`\`\`\n${code}\n\`\`\`\n（${note}）` : text,
    });
    session.messages.forEach(message => {
      if (message.from === 'user') {
        turns.push({ role: 'user', content: message.text });
      } else {
        turns.push(aiTurn(message.text, message.code, noteFor(message)));
      }
    });
    if (session.pending) {
      turns.push(aiTurn(session.pending.explanation, session.pending.code, '这份代码已提案，用户尚未决定'));
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
      messages.push({ from: 'ai', text: session.pending.explanation, code: session.pending.code, applied: false, superseded: true });
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
      history,
      context: {
        title: (titles || []).join(' / '),
        fileName: editingFile.name,
        files: (files || []).map(file => file.name),
      },
    }).then(({ code, explanation, changed, syntax }) => {
      this.setState({ busy: false });
      if (changed && code) {
        // The proposal is consumed into a line diff against the code
        // that was sent; the user accepts hunks, not a blind replace.
        const hunks = computeHunks(sentCode, code).map(hunk => ({ ...hunk, accepted: true }));
        this.updateSession({ pending: { code, explanation: explanation || '', syntax: syntax || null, hunks } }, key);
      } else {
        const current = this.sessionFor(key);
        this.updateSession({
          messages: [...current.messages, { from: 'ai', text: explanation || '（AI 没有返回说明。）', code: null, applied: false }],
        }, key);
      }
    }).catch(error => {
      const data = error && error.response && error.response.data;
      this.setState({
        busy: false,
        error: (data && data.message) || 'AI 请求失败，请确认 server 正在运行。',
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
      this.setState({ error: '所选段落的原文已被你在编辑器里改动，无法定位应用；可以丢弃提案后重新提问。' });
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
      }],
      pending: null,
    });
  }

  rejectProposal() {
    const session = this.session();
    if (!session.pending) return;
    this.updateSession({
      messages: [...session.messages, { from: 'ai', text: session.pending.explanation, code: session.pending.code, applied: false }],
      pending: null,
    });
  }

  sendFixSyntax() {
    const session = this.session();
    if (!session.pending || !session.pending.syntax || session.pending.syntax.ok) return;
    this.send(`你上一版返回的代码没有通过语法检查，报错如下：\n${session.pending.syntax.error}\n请修复这个问题后返回完整代码，其他部分保持不变。`);
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
          pending.syntax ? (
            pending.syntax.ok ? (
              <div className={styles.syntax_ok}>✓ 语法检查通过</div>
            ) : (
              <div className={styles.syntax_bad}>
                <div>⚠ 语法检查未通过 — 应用前请注意，或让 AI 先修：</div>
                <pre className={styles.code}>{pending.syntax.error}</pre>
                <button className={styles.chip} onClick={() => this.sendFixSyntax()}>让 AI 修复这个错误</button>
              </div>
            )
          ) : null
        }
        {
          pending.hunks.map(hunk => (
            <div key={hunk.id} className={`${styles.hunk} ${hunk.accepted ? '' : styles.hunk_dropped}`}>
              <div className={styles.hunk_header}>
                <span>修改 {hunk.id + 1}</span>
                <button className={styles.chip} onClick={() => this.toggleHunk(hunk.id)}>
                  {hunk.accepted ? '✓ 保留此段' : '已丢弃（点击恢复）'}
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
            应用所选修改（{acceptedCount}/{pending.hunks.length}）
          </button>
          <button className={styles.chip} onClick={() => this.rejectProposal()}>✗ 全部丢弃</button>
          <span className={styles.status}>或在下面继续追问</span>
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
          <span className={styles.title}>AI 助手</span>
          {
            PRESETS.map(preset => (
              <button key={preset.label} className={styles.chip} disabled={busy || !isCode}
                      onClick={() => this.send(preset.instruction)}>
                {preset.label}
              </button>
            ))
          }
          {hasSession ? (
            <button className={styles.chip} disabled={busy} onClick={() => this.clearSession()}>
              清空会话
            </button>
          ) : null}
        </div>
        <div className={styles.pad_name}>
          {editingFile ? `${editingFile.name} 的会话` : '未打开文件'}
        </div>
        <div className={styles.log} ref={this.logRef}>
          {
            !isCode ? (
              <div className={styles.empty_state}>
                当前文件不是代码文件。切到代码文件（.js / .java / .py / .cpp）后，这里会显示那个文件专属的 AI 会话。
              </div>
            ) : !hasSession && !busy ? (
              <div className={styles.empty_state}>
                这是 {editingFile.name} 专属的 AI 会话，每个文件的会话相互独立、会被记住。可以让 AI 写代码、加 Tracer、解释或找问题；它的改动会先以 diff 提案出现，你逐段确认后才应用到编辑器。
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
                            ? this.renderCodeCard(message, message.applied ? (message.partial ? '✓ 已部分应用' : '✓ 已应用到编辑器') : '未采用')
                            : <div className={styles.text}>{message.text}</div>
                        }
                      </div>
                    )
                  ))
                }
                {session.pending ? this.renderPending(session) : null}
                {busy ? <div className={styles.ai_message}>思考中…</div> : null}
              </React.Fragment>
            )
          }
        </div>
        <div className={styles.row}>
          <input className={styles.input} type="text" value={instruction} disabled={!isCode}
                 placeholder="告诉 AI 你想对这段代码做什么，例如：把冒泡排序改成快速排序"
                 onChange={e => this.setState({ instruction: e.target.value })}
                 onKeyDown={e => {
                   if (e.key === 'Enter') this.send();
                 }}/>
          <button className={styles.send} disabled={busy || !isCode || !instruction.trim()} onClick={() => this.send()}>
            {busy ? '生成中…' : '发送'}
          </button>
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }), actions)(AiAssistant);
