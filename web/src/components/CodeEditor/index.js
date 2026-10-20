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
  }

  handleResize() {
    this.aceEditorRef.current.resize();
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
                  <div key={language.ext} className={styles.lang_item}
                       onClick={() => this.props.setExt(language.ext)}>
                    {language.name}
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
