import React from 'react';
import Cookies from 'js-cookie';
import { connect } from 'react-redux';
import Promise from 'bluebird';
import { Helmet } from 'react-helmet';
import queryString from 'query-string';
import {
  AiAssistant,
  BaseComponent,
  CodeEditor,
  Header,
  Navigator,
  ResizableContainer,
  TabContainer,
  TestPanel,
  ToastContainer,
  VisualizationViewer,
} from 'components';
import { AlgorithmApi, GitHubApi, VisualizationApi } from 'apis';
import { actions } from 'reducers';
import { createUserFile, extension, refineGist } from 'common/util';
import { loadLayoutStore, saveLayoutStore } from 'common/layouts';
import { hydrateCodeCache } from 'common/savedCode';
import { exts, languages } from 'common/config';
import { LICENSE_MD, SCRATCH_PAPER_README_MD } from 'files';
import styles from './App.module.scss';

class App extends BaseComponent {
  constructor(props) {
    super(props);

    // The workspace arrangement is a layout (common/layouts):
    // restored from the last session when one was saved, with the
    // built-in Default strip as the starting point. Strip mode is
    // the native four-pane row; focus mode is the 2x2 grid.
    const layoutStore = loadLayoutStore();
    const current = layoutStore.current;
    this.state = {
      layoutMode: current ? current.mode : 'strip',
      workspaceVisibles: current && current.visibles ? [...current.visibles] : [true, true, true, false],
      workspaceWeights: current && current.weights ? [...current.weights] : [1, 2, 2, 1.4],
      focusCols: current && current.focus ? [...current.focus.cols] : [1, 1.15],
      focusRows: current && current.focus ? [...current.focus.rows] : [1, 1],
      customLayouts: layoutStore.custom,
    };

    this.codeEditorRef = React.createRef();

    this.ignoreHistoryBlock = this.ignoreHistoryBlock.bind(this);
    this.handleClickTitleBar = this.handleClickTitleBar.bind(this);
    this.loadScratchPapers = this.loadScratchPapers.bind(this);
    this.handleChangeWorkspaceWeights = this.handleChangeWorkspaceWeights.bind(this);
  }

  componentDidMount() {
    window.signIn = this.signIn.bind(this);
    window.signOut = this.signOut.bind(this);

    const { params } = this.props.match;
    const { search } = this.props.location;
    // Merge the server-side code cache into the local one first, so
    // the first page load already overlays the user's own code.
    hydrateCodeCache().then(() => this.loadAlgorithm(params, queryString.parse(search)));

    const accessToken = Cookies.get('access_token');
    if (accessToken) this.signIn(accessToken);

    AlgorithmApi.getCategories()
      .then(({ categories }) => this.props.setCategories(categories))
      .catch(this.handleError);

    this.toggleHistoryBlock(true);
  }

  componentWillUnmount() {
    delete window.signIn;
    delete window.signOut;

    this.toggleHistoryBlock(false);
  }

  componentWillReceiveProps(nextProps) {
    const { params } = nextProps.match;
    const { search } = nextProps.location;
    if (params !== this.props.match.params || search !== this.props.location.search) {
      const { categoryKey, algorithmKey, gistId } = params;
      const { algorithm, scratchPaper } = nextProps.current;
      if (algorithm && algorithm.categoryKey === categoryKey && algorithm.algorithmKey === algorithmKey) return;
      if (scratchPaper && scratchPaper.gistId === gistId) return;
      this.loadAlgorithm(params, queryString.parse(search));
    }
  }

  toggleHistoryBlock(enable = !this.unblock) {
    if (enable) {
      const warningMessage = 'Are you sure you want to discard changes?';
      window.onbeforeunload = () => {
        const { saved } = this.props.current;
        if (!saved) return warningMessage;
      };
      this.unblock = this.props.history.block((location) => {
        if (location.pathname === this.props.location.pathname) return;
        const { saved } = this.props.current;
        if (!saved) return warningMessage;
      });
    } else {
      window.onbeforeunload = undefined;
      this.unblock();
      this.unblock = undefined;
    }
  }

  ignoreHistoryBlock(process) {
    this.toggleHistoryBlock(false);
    process();
    this.toggleHistoryBlock(true);
  }

  signIn(accessToken) {
    Cookies.set('access_token', accessToken);
    GitHubApi.auth(accessToken)
      .then(() => GitHubApi.getUser())
      .then(user => {
        const { login, avatar_url } = user;
        this.props.setUser({ login, avatar_url });
      })
      .then(() => this.loadScratchPapers())
      .catch(() => this.signOut());
  }

  signOut() {
    Cookies.remove('access_token');
    GitHubApi.auth(undefined)
      .then(() => {
        this.props.setUser(undefined);
      })
      .then(() => this.props.setScratchPapers([]));
  }

  loadScratchPapers() {
    const per_page = 100;
    const paginateGists = (page = 1, scratchPapers = []) => GitHubApi.listGists({
      per_page,
      page,
      timestamp: Date.now(),
    }).then(gists => {
      scratchPapers.push(...gists.filter(gist => 'algorithm-visualizer' in gist.files).map(gist => ({
        key: gist.id,
        name: gist.description,
        files: Object.keys(gist.files),
      })));
      if (gists.length < per_page) {
        return scratchPapers;
      } else {
        return paginateGists(page + 1, scratchPapers);
      }
    });
    return paginateGists()
      .then(scratchPapers => this.props.setScratchPapers(scratchPapers))
      .catch(this.handleError);
  }

  loadAlgorithm({ categoryKey, algorithmKey, gistId }, { visualizationId }) {
    const { ext } = this.props.env;
    const fetch = () => {
      if (this.props.location.pathname === '/license') {
        // The License page: the file shows in the editor like any page,
        // and the markdown is also rendered in the center viewer through
        // a one-chunk MarkdownTracer visualization.
        this.props.setLicense();
        const key = 'license';
        this.props.setChunks([[
          { key, method: 'MarkdownTracer', args: ['License'] },
          { key, method: 'set', args: [LICENSE_MD.content] },
          { key: null, method: 'setRoot', args: [key] },
        ]]);
        this.props.setCursor(1);
      } else if (window.__PRELOADED_ALGORITHM__) {
        this.props.setAlgorithm(window.__PRELOADED_ALGORITHM__);
        delete window.__PRELOADED_ALGORITHM__;
      } else if (window.__PRELOADED_ALGORITHM__ === null) {
        delete window.__PRELOADED_ALGORITHM__;
        return Promise.reject(new Error('Algorithm Not Found'));
      } else if (categoryKey && algorithmKey) {
        return AlgorithmApi.getAlgorithm(categoryKey, algorithmKey)
          .then(({ algorithm }) => this.props.setAlgorithm(algorithm));
      } else if (gistId === 'new' && visualizationId) {
        return VisualizationApi.getVisualization(visualizationId)
          .then(content => {
            this.props.setScratchPaper({
              login: undefined,
              gistId,
              title: 'Untitled',
              files: [SCRATCH_PAPER_README_MD, createUserFile('visualization.json', JSON.stringify(content))],
            });
          });
      } else if (gistId === 'new') {
        const language = languages.find(language => language.ext === ext);
        this.props.setScratchPaper({
          login: undefined,
          gistId,
          title: 'Untitled',
          files: [SCRATCH_PAPER_README_MD, language.skeleton],
        });
      } else if (gistId) {
        return GitHubApi.getGist(gistId, { timestamp: Date.now() })
          .then(refineGist)
          .then(this.props.setScratchPaper);
      } else {
        this.props.setHome();
      }
      return Promise.resolve();
    };
    fetch()
      .then(() => {
        this.selectDefaultTab();
        return null; // to suppress unnecessary bluebird warning
      })
      .catch(error => {
        this.handleError(error);
        this.props.history.push('/');
      });
  }

  selectDefaultTab() {
    const { ext } = this.props.env;
    const { files } = this.props.current;
    const editingFile = files.find(file => extension(file.name) === 'json') ||
      files.find(file => extension(file.name) === ext) ||
      files.find(file => exts.includes(extension(file.name))) ||
      files[files.length - 1];
    this.props.setEditingFile(editingFile);
  }

  handleChangeWorkspaceWeights(workspaceWeights) {
    this.setState({ workspaceWeights }, () => {
      this.codeEditorRef.current.handleResize();
      this.persistLayout();
    });
  }

  // Layouts: named arrangements of the workspace (common/layouts).
  // Every change persists the current arrangement so a reload comes
  // back exactly as the user left it.
  currentLayoutSnapshot() {
    const { layoutMode, workspaceVisibles, workspaceWeights, focusCols, focusRows } = this.state;
    return layoutMode === 'focus'
      ? { name: 'Current', mode: 'focus', focus: { cols: [...focusCols], rows: [...focusRows] } }
      : { name: 'Current', mode: 'strip', visibles: [...workspaceVisibles], weights: [...workspaceWeights] };
  }

  persistLayout() {
    saveLayoutStore({
      custom: this.state.customLayouts,
      current: this.currentLayoutSnapshot(),
    });
  }

  applyLayout(layout) {
    const after = () => {
      if (this.codeEditorRef.current) this.codeEditorRef.current.handleResize();
      this.persistLayout();
    };
    if (layout.mode === 'focus') {
      this.setState({
        layoutMode: 'focus',
        focusCols: [...layout.focus.cols],
        focusRows: [...layout.focus.rows],
      }, after);
    } else {
      this.setState({
        layoutMode: 'strip',
        workspaceVisibles: [...layout.visibles],
        workspaceWeights: [...layout.weights],
      }, after);
    }
  }

  saveCustomLayout(name) {
    const entry = { ...this.currentLayoutSnapshot(), name };
    this.setState(prev => ({
      customLayouts: [...prev.customLayouts.filter(layout => layout.name !== name), entry],
    }), () => this.persistLayout());
  }

  deleteCustomLayout(name) {
    this.setState(prev => ({
      customLayouts: prev.customLayouts.filter(layout => layout.name !== name),
    }), () => this.persistLayout());
  }

  handleChangeFocusCols(focusCols) {
    this.setState({ focusCols }, () => this.persistLayout());
  }

  handleChangeFocusRows(focusRows) {
    this.setState({ focusRows }, () => this.persistLayout());
  }

  toggleNavigatorOpened(navigatorOpened = !this.state.workspaceVisibles[0]) {
    const workspaceVisibles = [...this.state.workspaceVisibles];
    workspaceVisibles[0] = navigatorOpened;
    this.setState({ workspaceVisibles }, () => this.persistLayout());
  }

  toggleAiPanelOpened(aiPanelOpened = !this.state.workspaceVisibles[3]) {
    const workspaceVisibles = [...this.state.workspaceVisibles];
    workspaceVisibles[3] = aiPanelOpened;
    this.setState({ workspaceVisibles }, () => this.persistLayout());
  }

  handleClickTitleBar() {
    this.toggleNavigatorOpened();
  }

  render() {
    const {
      layoutMode, workspaceVisibles, workspaceWeights, focusCols, focusRows, customLayouts,
    } = this.state;
    const { titles, description, saved } = this.props.current;

    const title = `${saved ? '' : '(Unsaved) '}${titles.join(' - ')}`;
    const navigatorOpened = workspaceVisibles[0];
    const aiPanelOpened = workspaceVisibles[3];

    return (
      <div className={styles.app}>
        <Helmet>
          <title>{title}</title>
          <meta name="description" content={description}/>
        </Helmet>
        <Header className={styles.header} onClickTitleBar={this.handleClickTitleBar}
                navigatorOpened={navigatorOpened} loadScratchPapers={this.loadScratchPapers}
                aiPanelOpened={aiPanelOpened} onToggleAiPanel={() => this.toggleAiPanelOpened()}
                currentLayout={this.currentLayoutSnapshot()}
                customLayouts={customLayouts}
                onApplyLayout={layout => this.applyLayout(layout)}
                onSaveLayout={name => this.saveCustomLayout(name)}
                onDeleteLayout={name => this.deleteCustomLayout(name)}
                ignoreHistoryBlock={this.ignoreHistoryBlock}/>
        {layoutMode === 'focus' ? (
          // Focus: 2x2 grid - problem Markdown (top-left) over the
          // Visualization, code pad (top-right) over the Testcase
          // panel (which starts collapsed in this layout).
          <ResizableContainer className={styles.workspace} horizontal weights={focusCols}
                              visibles={[true, true]} onChangeWeights={this.handleChangeFocusCols}>
            <ResizableContainer className={styles.fill} weights={focusRows}
                                visibles={[true, true]} onChangeWeights={this.handleChangeFocusRows}>
              <VisualizationViewer variant="doc" className={styles.visualization_viewer}/>
              <VisualizationViewer variant="viz" className={styles.visualization_viewer}/>
            </ResizableContainer>
            <div className={styles.focus_right}>
              <TabContainer hideTestPanel className={styles.editor_tab_container}>
                <CodeEditor ref={this.codeEditorRef}/>
              </TabContainer>
              <TestPanel startCollapsed/>
            </div>
          </ResizableContainer>
        ) : (
          <ResizableContainer className={styles.workspace} horizontal weights={workspaceWeights}
                              visibles={workspaceVisibles} onChangeWeights={this.handleChangeWorkspaceWeights}>
            <Navigator/>
            <VisualizationViewer className={styles.visualization_viewer}/>
            <TabContainer className={styles.editor_tab_container}>
              <CodeEditor ref={this.codeEditorRef}/>
            </TabContainer>
            <AiAssistant/>
          </ResizableContainer>
        )}
        <ToastContainer className={styles.toast_container}/>
      </div>
    );
  }
}

export default connect(({ current, env }) => ({ current, env }), actions)(
  App,
);
