import React from 'react';
import { connect } from 'react-redux';
import { actions } from 'reducers';
import { AiApi } from 'apis';
import { extension } from 'common/util';
import styles from './AiAssistant.module.scss';

// AI assistant for the coding pad: describe what you want (or tap a
// preset) and the server asks the configured LLM for the complete
// revised file, which then replaces the editor content. Explanations
// come back with the code and are shown under the input.
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

class AiAssistant extends React.Component {
  constructor(props) {
    super(props);
    this.state = { instruction: '', busy: false, message: '', error: '' };
  }

  send(instruction) {
    const { editingFile } = this.props.current;
    const text = (instruction !== undefined ? instruction : this.state.instruction).trim();
    if (!editingFile || !text || this.state.busy) return;
    this.setState({ busy: true, message: '', error: '' });
    AiApi.assist({
      code: editingFile.content,
      language: extension(editingFile.name),
      instruction: text,
    }).then(({ code, explanation }) => {
      let applied = false;
      if (code && code !== editingFile.content) {
        this.props.modifyFile(editingFile, code);
        applied = true;
      }
      this.setState({
        busy: false,
        message: [applied ? '已把 AI 返回的代码更新到编辑器。' : '', explanation || ''].filter(Boolean).join('\n'),
      });
    }).catch(error => {
      const data = error && error.response && error.response.data;
      this.setState({
        busy: false,
        error: (data && data.message) || 'AI 请求失败，请确认 server 正在运行。',
      });
    });
  }

  render() {
    const { editingFile } = this.props.current;
    if (!editingFile || !CODE_EXTS.includes(extension(editingFile.name))) return null;
    const { instruction, busy, message, error } = this.state;

    return (
      <div className={styles.ai_assistant}>
        <div className={styles.row}>
          <span className={styles.title}>AI 助手</span>
          {
            PRESETS.map(preset => (
              <button key={preset.label} className={styles.chip} disabled={busy}
                      onClick={() => {
                        this.setState({ instruction: preset.instruction });
                        this.send(preset.instruction);
                      }}>
                {preset.label}
              </button>
            ))
          }
        </div>
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
        {message ? <div className={styles.message}>{message}</div> : null}
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    );
  }
}

export default connect(({ current }) => ({ current }), actions)(AiAssistant);
