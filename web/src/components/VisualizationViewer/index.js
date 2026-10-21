import React from 'react';
import { connect } from 'react-redux';
import { BaseComponent } from 'components';
import { actions } from 'reducers';
import styles from './VisualizationViewer.module.scss';
import * as TracerClasses from 'core/tracers';
import * as LayoutClasses from 'core/layouts';
import { classes, extension } from 'common/util';
import { TracerApi } from 'apis';

class VisualizationViewer extends BaseComponent {
  constructor(props) {
    super(props);

    this.state = { docFile: null, closedDocs: [] };
    this.reset();
  }

  pageKey() {
    const { algorithm, scratchPaper } = this.props.current;
    return algorithm ? `${algorithm.categoryKey}/${algorithm.algorithmKey}` :
      scratchPaper ? `scratch:${scratchPaper.gistId}` : 'home';
  }

  // Markdown tabs can be closed (per page): closing hides the tab -
  // the file itself is untouched, and switching pages or reloading
  // brings the tabs back.
  visibleMdFiles() {
    const { files } = this.props.current;
    return (files || []).filter(file => extension(file.name) === 'md' &&
      !this.state.closedDocs.includes(`${this.pageKey()}:${file.name}`));
  }

  closeDoc(event, file) {
    event.stopPropagation();
    const key = `${this.pageKey()}:${file.name}`;
    this.setState(prev => ({ closedDocs: [...prev.closedDocs, key] }));
    if (this.state.docFile && this.state.docFile.name === file.name) {
      this.setState({ docFile: null });
      const { chunks, cursor } = this.props.player;
      this.reset();
      if (chunks && chunks.length) this.update(chunks, cursor, [], 0);
    }
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
    // While a Markdown doc is shown, the viewer is decoupled from the
    // player: builds and cursor moves in the code pad do not touch
    // it. Only follow the doc itself (deleted -> leave doc mode,
    // edited elsewhere -> re-render it).
    const docFile = this.state.docFile;
    if (docFile) {
      const fresh = (nextProps.current.files || []).find(file => file.name === docFile.name);
      if (!fresh) {
        this.setState({ docFile: null });
        const { chunks, cursor } = nextProps.player;
        this.reset();
        this.update(chunks, cursor, [], 0);
      } else if (fresh.content !== docFile.content) {
        this.showDoc(fresh);
      }
      return;
    }
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

  // Markdown files render here, in the center viewer, fully
  // independent of the code pad: switching tabs never changes the
  // pad's editing file, and editing or running code never disturbs
  // the doc being read. The doc is rendered locally through the same
  // MarkdownTracer pipeline the build uses.
  showDoc(file) {
    TracerApi.md({ code: file.content }).then(commands => {
      this.reset();
      this.applyChunk({ commands });
      this.props.setLineIndicator(undefined);
      this.setState({ docFile: file });
    });
  }

  showVisualization() {
    if (!this.state.docFile) return;
    this.setState({ docFile: null });
    const { chunks, cursor } = this.props.player;
    this.reset();
    if (chunks && chunks.length) this.update(chunks, cursor, [], 0);
  }

  render() {
    const { className } = this.props;
    const mdFiles = this.visibleMdFiles();
    const docFile = this.state.docFile;

    return (
      <div className={classes(styles.visualization_viewer, className)}>
        {
          mdFiles.length ? (
            <div className={styles.doc_tabs}>
              <div className={classes(styles.doc_tab, !docFile && styles.selected)}
                   onClick={() => this.showVisualization()}>
                Visualization
              </div>
              {
                mdFiles.map(file => (
                  <div key={file.name}
                       className={classes(styles.doc_tab, docFile && docFile.name === file.name && styles.selected)}
                       onClick={() => this.showDoc(file)}>
                    {file.name}
                    <span className={styles.doc_close} title="Close this tab"
                          onClick={event => this.closeDoc(event, file)}>
                      ×
                    </span>
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
