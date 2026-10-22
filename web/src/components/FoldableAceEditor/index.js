import { connect } from 'react-redux';
import AceEditor from 'react-ace';
import ace from 'brace';
import 'brace/mode/plain_text';
import 'brace/mode/markdown';
import 'brace/mode/json';
import 'brace/mode/javascript';
import 'brace/mode/c_cpp';
import 'brace/mode/java';
import 'brace/mode/python';
import 'brace/theme/tomorrow_night_eighties';
import 'brace/ext/searchbox';
import { actions } from 'reducers';
import { extension } from 'common/util';
import { tracerFoldEnabled, tracerFoldRanges, TRACER_FOLD_EVENT } from 'common/tracerFold';

const { Range } = ace.acequire('ace/range');

// The code pad's editor, with tracer-code folding: the
// visualization instrumentation (imports, tracer creations,
// layout calls, tracer method calls) is folded away so the core
// algorithm stays readable. Folding is a view-layer feature -
// the document text never changes. The preference is toggled
// from the CodeEditor footer (common/tracerFold) and defaults
// to on; it re-applies when a file is opened or its content is
// replaced (file switch, AI proposal, restore), never while the
// user is just typing.
class FoldableAceEditor extends AceEditor {
  componentDidMount() {
    super.componentDidMount();

    this.tracerFolds = [];
    this.handleTracerFoldPref = () => {
      if (tracerFoldEnabled()) this.applyTracerFolds();
      else this.removeTracerFolds();
    };
    window.addEventListener(TRACER_FOLD_EVENT, this.handleTracerFoldPref);
    if (tracerFoldEnabled()) this.applyTracerFolds();
  }

  componentWillUnmount() {
    if (this.handleTracerFoldPref) window.removeEventListener(TRACER_FOLD_EVENT, this.handleTracerFoldPref);
    if (super.componentWillUnmount) super.componentWillUnmount();
  }

  // react-ace only forwards editor changes to props.onChange
  // when they came from the user (programmatic setValue is
  // silent), so this override marks updates that are the user's
  // own typing - those must not trigger a refold.
  onChange(event) {
    this.selfEdited = true;
    super.onChange(event);
  }

  componentDidUpdate(prevProps, prevState, snapshot) {
    super.componentDidUpdate(prevProps, prevState, snapshot);

    const selfEdited = this.selfEdited;
    this.selfEdited = false;
    if (!tracerFoldEnabled() || !this.editor) return;
    const prevFile = prevProps.current && prevProps.current.editingFile;
    const file = this.props.current && this.props.current.editingFile;
    if (!file) return;
    const switched = !prevFile || prevFile.name !== file.name;
    const replaced = !selfEdited && !!prevFile && prevFile.content !== file.content;
    const buildStarted = this.props.current.shouldBuild && !(prevProps.current && prevProps.current.shouldBuild);
    if (switched || replaced || buildStarted) this.applyTracerFolds();
  }

  applyTracerFolds() {
    if (!this.editor) return;
    this.removeTracerFolds();
    const session = this.editor.getSession();
    const { editingFile } = this.props.current || {};
    const ext = editingFile ? extension(editingFile.name) : '';
    tracerFoldRanges(session.getValue(), ext).forEach(({ startRow, endRow }) => {
      const placeholder = startRow === endRow
        ? '··· tracer ···'
        : `··· ${endRow - startRow + 1} tracer lines ···`;
      try {
        const fold = session.addFold(placeholder, new Range(startRow, 0, endRow, session.getLine(endRow).length));
        if (fold) this.tracerFolds.push(fold);
      } catch (error) {
        // A range Ace refuses (e.g. already folded by hand) just
        // stays visible.
      }
    });
  }

  removeTracerFolds() {
    if (!this.editor || !this.tracerFolds) return;
    const session = this.editor.getSession();
    this.tracerFolds.forEach(fold => {
      try {
        session.removeFold(fold);
      } catch (error) {
        // Already gone (the user unfolded it, or the region was
        // edited away): nothing to do.
      }
    });
    this.tracerFolds = [];
  }

  // Kept for compatibility with the historical behavior: folds
  // the tracer code of the current file.
  foldTracers() {
    this.applyTracerFolds();
  }

  resize() {
    this.editor.resize();
  }
}

export default connect(({ current }) => ({ current }), actions, null, { forwardRef: true })(
  FoldableAceEditor,
);
