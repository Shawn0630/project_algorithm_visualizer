import React from 'react';
import { connect } from 'react-redux';
import { BaseComponent, TracerStage } from 'components';
import { actions } from 'reducers';
import styles from './VisualizationViewer.module.scss';
import * as TracerClasses from 'core/tracers';
import * as LayoutClasses from 'core/layouts';
import { classes, extension, VISUALIZE_CASE_EVENT } from 'common/util';
import { TracerApi } from 'apis';

// Splits a Markdown doc into segments: prose segments render
// through the MarkdownTracer as usual, and ```visualization
// fences (the Player's "Export for Markdown" output - a JSON
// object holding the recorded chunks) become embedded mini
// players. A fence whose payload does not parse stays prose, so
// a broken embed degrades to a code block, never to a crash.
function splitDoc(content) {
  const segments = [];
  const fence = /```visualization[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  let match = fence.exec(content);
  const pushMd = text => {
    if (text.trim()) segments.push({ kind: 'md', text });
  };
  while (match !== null) {
    pushMd(content.slice(last, match.index));
    let chunks = null;
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && Array.isArray(parsed.chunks)) chunks = parsed.chunks;
      else if (Array.isArray(parsed)) chunks = parsed;
    } catch (error) {
      chunks = null;
    }
    if (chunks) segments.push({ kind: 'viz', chunks });
    else pushMd(match[0]);
    last = match.index + match[0].length;
    match = fence.exec(content);
  }
  pushMd(content.slice(last));
  return segments.length ? segments : [{ kind: 'md', text: content }];
}

// One prose segment of a doc: rendered through the same
// MarkdownTracer pipeline as a whole doc, as its own little
// stage so viz embeds can sit between prose segments.
class MdSegment extends React.Component {
  constructor(props) {
    super(props);
    this.state = { commands: null };
    this.fetchToken = 0;
  }

  componentDidMount() {
    this.fetch(this.props.text);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.text !== this.props.text) this.fetch(this.props.text);
  }

  fetch(text) {
    const token = ++this.fetchToken;
    TracerApi.md({ code: text })
      .then(commands => {
        if (token === this.fetchToken) this.setState({ commands });
      })
      .catch(() => {
        if (token === this.fetchToken) this.setState({ commands: [] });
      });
  }

  render() {
    if (!this.state.commands) return <div className={styles.doc_loading}>Rendering…</div>;
    return <TracerStage bare static chunks={[{ commands: this.state.commands }]}/>;
  }
}

class VisualizationViewer extends BaseComponent {
  constructor(props) {
    super(props);

    this.state = { docFile: null, docSegments: null, closedDocs: [] };
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
      this.setState({ docFile: null, docSegments: null });
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
    if (this.props.variant === 'doc') {
      // Doc pane (Focus layout, top-left): always shows a Markdown
      // doc, never follows the player. On mount, preview the
      // Markdown file being edited, if any.
      const editing = this.props.current.editingFile;
      this.ensureDoc(this.props, editing && extension(editing.name) === 'md' ? editing.name : undefined);
      return;
    }
    const { chunks, cursor } = this.props.player;
    this.update(chunks, cursor);
    // A case visualization should be seen: leave Markdown-doc mode
    // so the playback shows (the Player loads the chunks itself).
    // The variant guard matters for dock instances reused across a
    // doc/viz tab switch: the listener stays registered, but a doc
    // pane must never flip to the player.
    this.handleVisualizeCase = () => {
      if (this.props.variant !== 'doc') this.showVisualization();
    };
    window.addEventListener(VISUALIZE_CASE_EVENT, this.handleVisualizeCase);
  }

  componentWillUnmount() {
    if (this.handleVisualizeCase) window.removeEventListener(VISUALIZE_CASE_EVENT, this.handleVisualizeCase);
  }

  componentWillReceiveProps(nextProps) {
    // The dock reuses this very instance when a leaf's active
    // panel switches between the 'doc' and 'viz' variants (same
    // component at the same tree position), so mount-time setup
    // never re-runs - and the variant must be read from nextProps:
    // deciding from this.props (the OLD variant) leaves the pane
    // stuck on whatever the previous variant was showing.
    if (nextProps.variant !== this.props.variant) {
      if (nextProps.variant === 'doc') {
        const editing = nextProps.current.editingFile;
        this.ensureDoc(nextProps, editing && extension(editing.name) === 'md' ? editing.name : undefined);
      } else {
        // Becoming the viz pane: drop any doc on screen and show
        // the player's current state. Forget the doc sync key
        // too - the doc is no longer on screen, so a later switch
        // back must not mistake "shown once" for "shown now".
        if (this.state.docFile) this.setState({ docFile: null, docSegments: null });
        this.docSyncKey = null;
        this.reset();
        const { chunks, cursor } = nextProps.player;
        if (chunks && chunks.length) this.update(chunks, cursor, [], 0);
      }
      return;
    }
    if (nextProps.variant === 'doc') {
      const editing = nextProps.current.editingFile;
      const prevEditing = this.props.current.editingFile;
      const switchedToMd = editing && extension(editing.name) === 'md' &&
        (!prevEditing || prevEditing.name !== editing.name);
      this.ensureDoc(nextProps, switchedToMd ? editing.name : undefined);
      return;
    }
    // Combined viewer (not the 'viz'-only leaf): when the pad's
    // editing file CHANGES to a Markdown note, the viewer
    // previews it - the same note-preview flow the doc pane has.
    // Clicking the Visualization doc tab hands the pane back to
    // the player.
    if (nextProps.variant !== 'viz') {
      const editing = nextProps.current.editingFile;
      const prevEditing = this.props.current.editingFile;
      const switchedToMd = editing && extension(editing.name) === 'md' &&
        (!prevEditing || prevEditing.name !== editing.name);
      if (switchedToMd) {
        const target = (nextProps.current.files || []).find(file => file.name === editing.name);
        if (target && (!this.state.docFile || this.state.docFile.name !== target.name)) {
          this.showDoc(target);
          return;
        }
      }
    }
    // While a Markdown doc is shown, the viewer is decoupled from the
    // player: builds and cursor moves in the code pad do not touch
    // it. Only follow the doc itself (deleted -> leave doc mode,
    // edited elsewhere -> re-render it).
    const docFile = this.state.docFile;
    if (docFile) {
      const fresh = (nextProps.current.files || []).find(file => file.name === docFile.name);
      if (!fresh) {
        this.setState({ docFile: null, docSegments: null });
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
  // the doc being read. The doc is split into segments (see
  // splitDoc): prose renders through the MarkdownTracer pipeline,
  // and ```visualization embeds render as mini players.
  showDoc(file) {
    this.props.setLineIndicator(undefined);
    this.setState({ docFile: file, docSegments: splitDoc(file.content || '') });
  }

  showVisualization() {
    if (!this.state.docFile) return;
    this.setState({ docFile: null, docSegments: null });
    const { chunks, cursor } = this.props.player;
    this.reset();
    if (chunks && chunks.length) this.update(chunks, cursor, [], 0);
  }

  // Doc-pane mode: keep a Markdown doc on screen at all times.
  // When the pad's editing file CHANGES to a Markdown file, the
  // pane previews that file (the note-preview flow: write in the
  // pad, read here); otherwise the doc already shown stays, else
  // the page's README (or its first Markdown file). Follows
  // edits and page switches.
  ensureDoc(props, forceName) {
    const files = (props.current.files || []).filter(file => extension(file.name) === 'md');
    const current = this.state.docFile;
    const forced = forceName ? files.find(file => file.name === forceName) : undefined;
    const shown = current && files.find(file => file.name === current.name);
    if (!forced && shown) {
      if (shown.content !== current.content) this.showDoc(shown);
      return;
    }
    const target = forced || files.find(file => /readme/i.test(file.name)) || files[0];
    if (target) {
      const syncKey = `${target.name}:${target.content.length}:${target.content.slice(0, 32)}`;
      if (this.docSyncKey !== syncKey) {
        this.docSyncKey = syncKey;
        this.showDoc(target);
      }
    } else if (current) {
      this.setState({ docFile: null, docSegments: null });
      this.reset();
    }
  }

  render() {
    const { className, variant } = this.props;
    const mdFiles = this.visibleMdFiles();
    const docFile = this.state.docFile;
    const docSegments = this.state.docSegments;
    // 'viz' variant: visualization only, no doc tabs. 'doc'
    // variant: the page's Markdown only, no Visualization tab.
    // Default (combined): both, as one tabbed viewer.
    const showTabs = variant !== 'viz' && mdFiles.length > 0;

    return (
      <div className={classes(styles.visualization_viewer, className)}>
        {
          showTabs ? (
            <div className={styles.doc_tabs}>
              {
                variant === 'doc' ? null : (
                  <div className={classes(styles.doc_tab, !docFile && styles.selected)}
                       onClick={() => this.showVisualization()}>
                    Visualization
                  </div>
                )
              }
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
          {
            docSegments ? (
              <div className={styles.doc_scroll}>
                {
                  docSegments.map((segment, i) => segment.kind === 'viz' ? (
                    <TracerStage key={i} chunks={segment.chunks} autoplay controls/>
                  ) : (
                    <MdSegment key={i} text={segment.text}/>
                  ))
                }
              </div>
            ) : (this.root && this.root.render())
          }
          {variant === 'doc' && !mdFiles.length
            ? <div className={styles.doc_empty}>No Markdown document on this page.</div>
            : null}
        </div>
      </div>
    );
  }
}

export default connect(({ player, current }) => ({ player, current }), actions)(
  VisualizationViewer,
);
