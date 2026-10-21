import React from 'react';
import { connect } from 'react-redux';
import { BaseComponent } from 'components';
import { actions } from 'reducers';
import styles from './VisualizationViewer.module.scss';
import * as TracerClasses from 'core/tracers';
import * as LayoutClasses from 'core/layouts';
import { classes, extension } from 'common/util';

const CODE_EXTS = ['js', 'java', 'py', 'cpp', 'json'];

class VisualizationViewer extends BaseComponent {
  constructor(props) {
    super(props);

    this.reset();
  }

  reset() {
    this.root = null;
    this.objects = {};
  }

  componentDidMount() {
    const { chunks, cursor } = this.props.player;
    this.update(chunks, cursor);
  }

  componentWillReceiveProps(nextProps) {
    const { chunks, cursor } = nextProps.player;
    const { chunks: oldChunks, cursor: oldCursor } = this.props.player;
    if (chunks !== oldChunks || cursor !== oldCursor) {
      this.update(chunks, cursor, oldChunks, oldCursor);
    }
  }

  update(chunks, cursor, oldChunks = [], oldCursor = 0) {
    let applyingChunks;
    if (cursor > oldCursor) {
      applyingChunks = chunks.slice(oldCursor, cursor);
    } else {
      this.reset();
      applyingChunks = chunks.slice(0, cursor);
    }
    applyingChunks.forEach(chunk => this.applyChunk(chunk));

    const lastChunk = applyingChunks[applyingChunks.length - 1];
    if (lastChunk && lastChunk.lineNumber !== undefined) {
      this.props.setLineIndicator({ lineNumber: lastChunk.lineNumber, cursor });
    } else {
      this.props.setLineIndicator(undefined);
    }
  }

  applyCommand(command) {
    const { key, method, args } = command;
    try {
      if (key === null && method === 'setRoot') {
        const [root] = args;
        this.root = this.objects[root];
      } else if (method === 'destroy') {
        delete this.objects[key];
      } else if (method in LayoutClasses) {
        const [children] = args;
        const LayoutClass = LayoutClasses[method];
        this.objects[key] = new LayoutClass(key, key => this.objects[key], children);
      } else if (method in TracerClasses) {
        const className = method;
        const [title = className] = args;
        const TracerClass = TracerClasses[className];
        this.objects[key] = new TracerClass(key, key => this.objects[key], title);
      } else {
        this.objects[key][method](...args);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  applyChunk(chunk) {
    chunk.commands.forEach(command => this.applyCommand(command));
  }

  // Markdown files render here, not in the code pad: the viewer gets
  // a tab per Markdown file next to the Visualization tab. Selecting
  // one makes it the editing file, which the app auto-builds into
  // this viewer (MarkdownTracer); the Visualization tab switches back
  // to the first code file.
  showVisualization() {
    const { files, editingFile } = this.props.current;
    if (!editingFile || extension(editingFile.name) !== 'md') return;
    const firstCode = files.find(file => CODE_EXTS.includes(extension(file.name)));
    if (firstCode) this.props.setEditingFile(firstCode);
  }

  render() {
    const { className } = this.props;
    const { files, editingFile } = this.props.current;
    const mdFiles = (files || []).filter(file => extension(file.name) === 'md');
    const activeMd = editingFile && extension(editingFile.name) === 'md' ? editingFile : null;

    return (
      <div className={classes(styles.visualization_viewer, className)}>
        {
          mdFiles.length ? (
            <div className={styles.doc_tabs}>
              <div className={classes(styles.doc_tab, !activeMd && styles.selected)}
                   onClick={() => this.showVisualization()}>
                Visualization
              </div>
              {
                mdFiles.map(file => (
                  <div key={file.name}
                       className={classes(styles.doc_tab, activeMd === file && styles.selected)}
                       onClick={() => this.props.setEditingFile(file)}>
                    {file.name}
                  </div>
                ))
              }
            </div>
          ) : null
        }
        <div className={styles.viewport}>
          {this.root && this.root.render()}
        </div>
      </div>
    );
  }
}

export default connect(({ player, current }) => ({ player, current }), actions)(
  VisualizationViewer,
);
