import React from 'react';
import { connect } from 'react-redux';
import AutosizeInput from 'react-input-autosize';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import faPlus from '@fortawesome/fontawesome-free-solid/faPlus';
import faTimes from '@fortawesome/fontawesome-free-solid/faTimes';
import { classes, extension, notifyAiSessionDeleted } from 'common/util';
import { actions } from 'reducers';
import { languages } from 'common/config';
import TestPanel from 'components/TestPanel';
import styles from './TabContainer.module.scss';

class TabContainer extends React.Component {
  constructor(props) {
    super(props);
    this.state = { armedFile: null, addMenu: false, editingName: null, editingFile: null };
    this.armTimeout = null;
  }

  componentWillUnmount() {
    if (this.armTimeout) window.clearTimeout(this.armTimeout);
  }

  // The + button offers every pad file kind (the four languages
  // plus a Markdown note); the new file starts from that kind's
  // skeleton, named after it (code.js, notes.md, ...) with a
  // numeric suffix when the name is taken.
  handleAddFile(language) {
    const { files } = this.props.current;
    const newFile = { ...language.skeleton };
    const dot = newFile.name.lastIndexOf('.');
    const stem = dot > 0 ? newFile.name.slice(0, dot) : newFile.name;
    let count = 0;
    while (files.some(file => file.name === newFile.name)) newFile.name = `${stem}-${++count}.${language.ext}`;
    this.setState({ addMenu: false });
    this.props.addFile(newFile);
  }

  // Renaming is commit-based: typing only edits local state, and
  // the rename lands on Enter or blur. (The old per-keystroke
  // rename dispatched on the first character - renaming
  // notes.md started by renaming it to "n", an extensionless
  // name the pad cannot show, so the file vanished from the tab
  // bar mid-rename.) A commit is also validated: the name must
  // be non-empty, unique on the page, and keep a pad-visible
  // extension (a language, Markdown or JSON).
  commitRename() {
    const { editingName, editingFile } = this.state;
    this.setState({ editingName: null, editingFile: null });
    if (!editingFile || editingName === null) return;
    const name = editingName.trim();
    if (!name || name === editingFile.name) return;
    const { files } = this.props.current;
    if (files.some(file => file !== editingFile && file.name === name)) return;
    const ext = extension(name);
    if (ext !== 'json' && !languages.some(language => language.ext === ext)) return;
    this.props.renameFile(editingFile, name);
  }

  // Two-click close, mirroring the app's confirm-needed buttons: the
  // first click arms the tab's x, the second deletes the file - and
  // its AI session goes with it.
  handleCloseFile(e, file) {
    e.stopPropagation();
    if (this.state.armedFile !== file) {
      if (this.armTimeout) window.clearTimeout(this.armTimeout);
      this.setState({ armedFile: file });
      this.armTimeout = window.setTimeout(() => this.setState({ armedFile: null }), 2000);
      return;
    }
    if (this.armTimeout) window.clearTimeout(this.armTimeout);
    this.setState({ armedFile: null });
    notifyAiSessionDeleted(this.props.current, file.name);
    this.props.deleteFile(file);
  }

  // The code pad holds the page's editable files: code files
  // (supported languages), JSON data files and Markdown notes.
  // Other text files render in the center viewer instead and get
  // no tab here.
  visibleFiles() {
    const { files } = this.props.current;
    return files.filter(file => {
      const ext = extension(file.name);
      return ext === 'json' || languages.some(language => language.ext === ext);
    });
  }

  renderClose(file) {
    if (this.visibleFiles().length <= 1) return null;
    const armed = this.state.armedFile === file;
    return (
      <span className={classes(styles.close, armed && styles.armed)}
            title={armed ? 'Click again to confirm' : 'Delete this file'}
            onClick={e => this.handleCloseFile(e, file)}>
        {armed ? 'Sure?' : <FontAwesomeIcon fixedWidth icon={faTimes}/>}
      </span>
    );
  }

  render() {
    const { className, children } = this.props;
    const { editingFile } = this.props.current;
    const files = this.visibleFiles();

    return (
      <div className={classes(styles.tab_container, className)}>
        <div className={styles.tab_bar}>
          <div className={classes(styles.title, styles.fake)}/>
          {
            files.map((file, i) => file === editingFile ? (
              <div className={classes(styles.title, styles.selected)} key={i}
                   onClick={() => this.props.setEditingFile(file)}>
                <AutosizeInput className={styles.input_title} key={file.name}
                               value={this.state.editingFile === file && this.state.editingName !== null
                                 ? this.state.editingName : file.name}
                               onClick={e => e.stopPropagation()}
                               onChange={e => this.setState({ editingName: e.target.value, editingFile: file })}
                               onBlur={() => this.commitRename()}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') e.currentTarget.blur();
                                 if (e.key === 'Escape') {
                                   this.setState({ editingName: null, editingFile: null }, () => e.currentTarget.blur());
                                 }
                               }}/>
                {this.renderClose(file)}
              </div>
            ) : (
              <div className={styles.title} key={i} onClick={() => this.props.setEditingFile(file)}>
                {file.name}
                {this.renderClose(file)}
              </div>
            ))
          }
          <div className={styles.title} title="New file"
               onClick={() => this.setState(prev => ({ addMenu: !prev.addMenu }))}>
            <FontAwesomeIcon fixedWidth icon={faPlus}/>
          </div>
          <div className={classes(styles.title, styles.fake)}/>
        </div>
        <div className={styles.content}>
          {children}
        </div>
        {this.props.hideTestPanel ? null : <TestPanel/>}
        {
          this.state.addMenu ? (
            <div className={styles.add_menu}>
              {
                languages.map(language => (
                  <div key={language.ext} className={styles.add_item}
                       onClick={() => this.handleAddFile(language)}>
                    {language.name}
                    <span className={styles.add_ext}>.{language.ext}</span>
                  </div>
                ))
              }
            </div>
          ) : null
        }
      </div>
    );
  }
}

export default connect(({ current, env }) => ({ current, env }), actions)(
  TabContainer,
);
