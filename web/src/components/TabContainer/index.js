import React from 'react';
import { connect } from 'react-redux';
import AutosizeInput from 'react-input-autosize';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import faPlus from '@fortawesome/fontawesome-free-solid/faPlus';
import faTimes from '@fortawesome/fontawesome-free-solid/faTimes';
import { classes, notifyAiSessionDeleted } from 'common/util';
import { actions } from 'reducers';
import { languages } from 'common/config';
import styles from './TabContainer.module.scss';

class TabContainer extends React.Component {
  constructor(props) {
    super(props);
    this.state = { armedFile: null };
    this.armTimeout = null;
  }

  componentWillUnmount() {
    if (this.armTimeout) window.clearTimeout(this.armTimeout);
  }

  handleAddFile() {
    const { ext } = this.props.env;
    const { files } = this.props.current;
    const language = languages.find(language => language.ext === ext);
    const newFile = { ...language.skeleton };
    let count = 0;
    while (files.some(file => file.name === newFile.name)) newFile.name = `code-${++count}.${ext}`;
    this.props.addFile(newFile);
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

  renderClose(file) {
    if (this.props.current.files.length <= 1) return null;
    const armed = this.state.armedFile === file;
    return (
      <span className={classes(styles.close, armed && styles.armed)}
            title={armed ? '再点一次确认删除' : '删除此文件'}
            onClick={e => this.handleCloseFile(e, file)}>
        {armed ? '确认' : <FontAwesomeIcon fixedWidth icon={faTimes}/>}
      </span>
    );
  }

  render() {
    const { className, children } = this.props;
    const { editingFile, files } = this.props.current;

    return (
      <div className={classes(styles.tab_container, className)}>
        <div className={styles.tab_bar}>
          <div className={classes(styles.title, styles.fake)}/>
          {
            files.map((file, i) => file === editingFile ? (
              <div className={classes(styles.title, styles.selected)} key={i}
                   onClick={() => this.props.setEditingFile(file)}>
                <AutosizeInput className={styles.input_title} value={file.name}
                               onClick={e => e.stopPropagation()}
                               onChange={e => this.props.renameFile(file, e.target.value)}/>
                {this.renderClose(file)}
              </div>
            ) : (
              <div className={styles.title} key={i} onClick={() => this.props.setEditingFile(file)}>
                {file.name}
                {this.renderClose(file)}
              </div>
            ))
          }
          <div className={styles.title} onClick={() => this.handleAddFile()}>
            <FontAwesomeIcon fixedWidth icon={faPlus}/>
          </div>
          <div className={classes(styles.title, styles.fake)}/>
        </div>
        <div className={styles.content}>
          {children}
        </div>
      </div>
    );
  }
}

export default connect(({ current, env }) => ({ current, env }), actions)(
  TabContainer,
);
