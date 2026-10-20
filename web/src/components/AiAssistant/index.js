import React from 'react';
import { connect } from 'react-redux';
import { actions } from 'reducers';
import { AiApi } from 'apis';
import { extension } from 'common/util';
import styles from './AiAssistant.module.scss';

// AI assistant with a per-pad session. Every code pad (one file of one
// algorithm / scratch paper) owns a conversation that lives as long as
// this window: the AI sees the window context (page, file list, the
// current editor content) plus the session history on every request.
// A code change comes back as a PROPOSAL first - it is written to the
// editor only when the user accepts it; rejecting it, or simply asking
// a follow-up, keeps the conversation going with the proposal folded
// into the history so the AI knows what happened to it.
const CODE_EXTS = ['js', 'java', 'py', 'cpp'];

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
    this.state = { sessions: {}, instruction: '', busy: false, error: '' };
    this.logRef = React.createRef();
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.sessions !== this.state.sessions && this.logRef.current) {
      this.logRef.current.scrollTop = this.logRef.current.scrollHeight;
    }
  }

  padKey() {
    const { algorithm, scratchPaper, editingFile } = this.props.current;
    if (!editingFile) return null;
    const page = scratchPaper ? `scratch:${scratchPaper.gistId}` :
      algorithm ? `${algorithm.categoryKey}/${algorithm.algorithmKey}` : 'home';
    return `${page}:${editingFile.name}`;
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
    const aiTurn = (text, code, note) => ({
      role: 'assistant',
      content: code ? `${text}\n\n\`\`\`\n${code}\n\`\`\`\n（${note}）` : text,
    });
    session.messages.forEach(message => {
      if (message.from === 'user') {
        turns.push({ role: 'user', content: message.text });
      } else {
        turns.push(aiTurn(message.text, message.code, message.applied ? '这份代码已被用户应用到编辑器' : '这份代码未被用户采用'));
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

    // Fold a still-pending proposal into the history as not applied,
    // then start the new turn.
    const session = this.session();
    const messages = [...session.messages];
    if (session.pending) {
      messages.push({ from: 'ai', text: session.pending.explanation, code: session.pending.code, applied: false });
    }
    messages.push({ from: 'user', text });
    const history = this.buildHistory({ messages: messages.slice(0, -1), pending: null });
    this.updateSession({ messages, pending: null }, key);
    this.setState({ busy: true, error: '', instruction: '' });

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
    }).then(({ code, explanation, changed }) => {
      this.setState({ busy: false });
      if (changed && code) {
        this.updateSession({ pending: { code, explanation: explanation || '' } }, key);
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

  acceptProposal() {
    const { editingFile } = this.props.current;
    const session = this.session();
    if (!editingFile || !session.pending) return;
    this.props.modifyFile(editingFile, session.pending.code);
    this.updateSession({
      messages: [...session.messages, { from: 'ai', text: session.pending.explanation, code: session.pending.code, applied: true }],
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

  clearSession() {
    this.updateSession(emptySession());
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
    if (!editingFile || !CODE_EXTS.includes(extension(editingFile.name))) return null;
    const { instruction, busy, error } = this.state;
    const session = this.session();
    const hasSession = session.messages.length > 0 || session.pending;

    return (
      <div className={styles.ai_assistant}>
        <div className={styles.row}>
          <span className={styles.title}>AI 助手</span>
          {
            PRESETS.map(preset => (
              <button key={preset.label} className={styles.chip} disabled={busy}
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
          <span className={styles.pad_name}>{editingFile.name} 的会话</span>
        </div>
        {
          hasSession ? (
            <div className={styles.log} ref={this.logRef}>
              {
                session.messages.map((message, i) => (
                  message.from === 'user' ? (
                    <div key={i} className={styles.user_message}>{message.text}</div>
                  ) : (
                    <div key={i} className={styles.ai_message}>
                      {
                        message.code
                          ? this.renderCodeCard(message, message.applied ? '✓ 已应用到编辑器' : '未采用')
                          : <div className={styles.text}>{message.text}</div>
                      }
                    </div>
                  )
                ))
              }
              {
                session.pending ? (
                  <div className={styles.pending}>
                    {session.pending.explanation ? <div className={styles.text}>{session.pending.explanation}</div> : null}
                    <pre className={styles.code}>{session.pending.code}</pre>
                    <div className={styles.row}>
                      <button className={styles.accept} onClick={() => this.acceptProposal()}>✓ 应用到编辑器</button>
                      <button className={styles.chip} onClick={() => this.rejectProposal()}>✗ 丢弃</button>
                      <span className={styles.status}>或在下面继续追问</span>
                    </div>
                  </div>
                ) : null
              }
              {busy ? <div className={styles.ai_message}>思考中…</div> : null}
            </div>
          ) : null
        }
        <div className={styles.row}>
          <input className={styles.input} type="text" value={instruction}
                 placeholder="告诉 AI 你想对这段代码做什么，例如：把冒泡排序改成快速排序"
                 onChange={e => this.setState({ instruction: e.target.value })}
                 onKeyDown={e => {
                   if (e.key === 'Enter') this.send();
                 }}/>
          <button className={styles.send} disabled={busy || !instruction.trim()} onClick={() => this.send()}>
            {busy ? '生成中…' : '发送'}
          </button>
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }), actions)(AiAssistant);
