import React from 'react';
import faTrashAlt from '@fortawesome/fontawesome-free-solid/faTrashAlt';
import faUser from '@fortawesome/fontawesome-free-solid/faUser';
import faCaretUp from '@fortawesome/fontawesome-free-solid/faCaretUp';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { classes, extension, notifyAiSessionDeleted } from 'common/util';
import { actions } from 'reducers';
import { connect } from 'react-redux';
import { languages } from 'common/config';
import { Button, Ellipsis, FoldableAceEditor } from 'components';
import styles from './CodeEditor.module.scss';

class CodeEditor extends React.Component {
  constructor(props) {
    super(props);

    this.aceEditorRef = React.createRef();
    this.state = { armedLang: null };
    this.armTimeout = null;
  }

  componentWillUnmount() {
    if (this.armTimeout) window.clearTimeout(this.armTimeout);
  }

  handleResize() {
    this.aceEditorRef.current.resize();
  }

  // Selecting a language replaces the current file with that
  // language's template (name and content, atomically). When the file
  // holds real work the first click only arms the menu item - the
  // second click confirms the replacement.
  handleSelectLanguage(language) {
    const { editingFile } = this.props.current;
    const pristine = !editingFile.content.trim() ||
      languages.some(each => each.skeleton.content === editingFile.content);
    if (!pristine && this.state.armedLang !== language.ext) {
      if (this.armTimeout) window.clearTimeout(this.armTimeout);
      this.setState({ armedLang: language.ext });
      this.armTimeout = window.setTimeout(() => this.setState({ armedLang: null }), 2500);
      return;
    }
    if (this.armTimeout) window.clearTimeout(this.armTimeout);
    this.setState({ armedLang: null });
    this.applyLanguage(language);
  }

  applyLanguage(language) {
    const { editingFile, files } = this.props.current;
    let name = language.skeleton.name;
    let count = 0;
    while (files.some(file => file !== editingFile && file.name === name)) {
      name = `code-${++count}.${language.ext}`;
    }
    this.props.setExt(language.ext);
    if (name !== editingFile.name) {
      notifyAiSessionDeleted(this.props.current, editingFile.name);
    }
    this.props.replaceFile(editingFile, name, language.skeleton.content);
  }

  render() {
    const { className } = this.props;
    const { editingFile } = this.props.current;
    const { user, ext } = this.props.env;
    const currentLanguage = languages.find(language => language.ext === ext);
    const { lineIndicator } = this.props.player;

    if (!editingFile) return null;

    const fileExt = extension(editingFile.name);
    const language = languages.find(language => language.ext === fileExt);
    const mode = language ? language.mode :
      fileExt === 'md' ? 'markdown' :
        fileExt === 'json' ? 'json' :
          'plain_text';

    return (
      <div className={classes(styles.code_editor, className)}>
        <FoldableAceEditor
          className={styles.ace_editor}
          ref={this.aceEditorRef}
          mode={mode}
          theme="tomorrow_night_eighties"
          name="code_editor"
          editorProps={{ $blockScrolling: true }}
          onChange={code => this.props.modifyFile(editingFile, code)}
          markers={lineIndicator ? [{
            startRow: lineIndicator.lineNumber,
            startCol: 0,
            endRow: lineIndicator.lineNumber,
            endCol: Infinity,
            className: styles.current_line_marker,
            type: 'line',
            inFront: true,
            _key: lineIndicator.cursor,
          }] : []}
          value={editingFile.content}/>
        <div className={classes(styles.contributors_viewer, className)}>
          <div className={styles.lang_select}>
            <span className={styles.lang_label}>
              {currentLanguage ? currentLanguage.name : ext}
              <FontAwesomeIcon fixedWidth icon={faCaretUp}/>
            </span>
            <div className={styles.lang_menu}>
              {
                languages.filter(language => language.ext !== ext).map(language => (
                  <div key={language.ext}
                       className={classes(styles.lang_item, this.state.armedLang === language.ext && styles.armed)}
                       onClick={() => this.handleSelectLanguage(language)}>
                    {this.state.armedLang === language.ext ? `用 ${language.name} 模板替换当前代码？` : language.name}
                  </div>
                ))
              }
            </div>
          </div>
          {/* <span className={classes(styles.contributor, styles.label)}>Contributed by</span>
          {
            (editingFile.contributors || [user || { login: 'guest', avatar_url: faUser }]).map(contributor => (
              <Button className={styles.contributor} icon={contributor.avatar_url} key={contributor.login}
                      href={`https://github.com/${contributor.login}`}>
                {contributor.login}
              </Button>
            ))
          } */}
          <div className={styles.empty}>
            <div className={styles.empty}/>
            <Button className={styles.delete} icon={faTrashAlt} primary confirmNeeded
                    onClick={() => {
                      notifyAiSessionDeleted(this.props.current, editingFile.name);
                      this.props.deleteFile(editingFile);
                    }}>
              <Ellipsis>Delete File</Ellipsis>
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export default connect(({ current, env, player }) => ({ current, env, player }), actions, null, { forwardRef: true })(
  CodeEditor,
);
