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
  DockWorkspace,
  Header,
  Navigator,
  TabContainer,
  TestPanel,
  ToastContainer,
  VisualizationViewer,
} from 'components';
import { AlgorithmApi, GitHubApi, VisualizationApi } from 'apis';
import { actions } from 'reducers';
import { createUserFile, extension, refineGist, VISUALIZE_CASE_EVENT } from 'common/util';
import {
  ensurePanel, findLeafByPanel, loadDockStore, normalizeTree, removePanel,
  saveDockStore, setActivePanel, treePanels,
} from 'common/dock';
import { hydrateCodeCache } from 'common/savedCode';
import { exts, languages } from 'common/config';
import { LICENSE_MD, SCRATCH_PAPER_README_MD } from 'files';
import styles from './App.module.scss';

// The code pad's open file is remembered per page (in
// localStorage), so a refresh - or a later visit - reopens the
// file the user was actually editing instead of snapping back
// to the default-language file. This matters most on imported
// LeetCode problems, which carry one starter file per language:
// opening code.py and refreshing used to land back on code.js.
const EDITING_FILE_KEY = 'av-editing-files-v1';

function pageKeyOf(current) {
  const { algorithm, scratchPaper } = current || {};
  return algorithm ? `${algorithm.categoryKey}/${algorithm.algorithmKey}`
    : scratchPaper ? `scratch:${scratchPaper.gistId}` : null;
}

function loadEditingFileMap() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EDITING_FILE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function rememberEditingFile(current, fileName) {
  const pageKey = pageKeyOf(current);
  if (!pageKey || !fileName) return;
  try {
    const map = loadEditingFileMap();
    if (map[pageKey] === fileName) return;
    map[pageKey] = fileName;
    const keys = Object.keys(map);
    if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(key => delete map[key]);
    window.localStorage.setItem(EDITING_FILE_KEY, JSON.stringify(map));
  } catch (error) {
    // Storage unavailable: the pad simply uses its defaults.
  }
}

class App extends BaseComponent {
  constructor(props) {
    super(props);

    // The workspace arrangement is a dock tree (common/dock):
    // panels in split/tab groups the user rearranges by dragging.
    // Restored from the last session when one was saved (the old
    // strip/focus layout store migrates into a tree on first
    // load), with the built-in Default tree as the starting point.
    const dockStore = loadDockStore();
    this.state = {
      dockTree: dockStore.current,
      customLayouts: dockStore.custom,
    };

    this.codeEditorRef = React.createRef();

    this.ignoreHistoryBlock = this.ignoreHistoryBlock.bind(this);
    this.handleClickTitleBar = this.handleClickTitleBar.bind(this);
    this.loadScratchPapers = this.loadScratchPapers.bind(this);
    this.handleDockChange = this.handleDockChange.bind(this);
    this.handleVisualizeCase = this.handleVisualizeCase.bind(this);
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
    // Persist the arrangement as loaded (including a migrated
    // legacy layout), so the store on disk always matches what
    // is on screen from the first paint on.
    this.persistDock();
    // A visualized test case should be seen: if the Visualization
    // panel shares a tab group, bring its tab forward.
    window.addEventListener(VISUALIZE_CASE_EVENT, this.handleVisualizeCase);
  }

  handleVisualizeCase() {
    const { dockTree } = this.state;
    const leaf = findLeafByPanel(dockTree, 'viz');
    if (leaf && leaf.active !== 'viz') {
      this.handleDockChange(setActivePanel(dockTree, 'viz'));
    }
  }

  componentDidUpdate(prevProps) {
    // Keep the per-page open-file memory current (see the note at
    // the top of this file).
    const prevFile = prevProps.current && prevProps.current.editingFile;
    const nextFile = this.props.current && this.props.current.editingFile;
    if (nextFile && nextFile !== prevFile) {
      rememberEditingFile(this.props.current, nextFile.name);
    }
  }

  componentWillUnmount() {
    delete window.signIn;
    delete window.signOut;

    window.removeEventListener(VISUALIZE_CASE_EVENT, this.handleVisualizeCase);
    this.toggleHistoryBlock(false);
  }

  componentWillReceiveProps(nextProps) {
    // A Build starting should be seen too: same tab activation as
    // for a visualized case. Markdown files never build into the
    // player (the doc pane previews them), so their edits must not
    // yank the viz panel forward.
    if (nextProps.current.shouldBuild && !this.props.current.shouldBuild) {
      const buildingFile = nextProps.current.editingFile;
      if (!buildingFile || extension(buildingFile.name) !== 'md') {
        this.handleVisualizeCase();
      }
    }
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
    // The file this page had open last time wins over every
    // default below - provided it still exists and is a file the
    // code pad can show (a language file or JSON).
    const rememberedName = loadEditingFileMap()[pageKeyOf(this.props.current)] || null;
    const remembered = rememberedName && files.find(file => file.name === rememberedName &&
      (exts.includes(extension(file.name)) || extension(file.name) === 'json'));
    // Otherwise open on the code file, not on a JSON sidecar: the
    // old json-first rule existed for scratch papers'
    // visualization.json (kept, by name), but for problems it
    // landed the pad on tests.json instead of the code the user
    // came to edit.
    const editingFile = remembered ||
      files.find(file => file.name === 'visualization.json') ||
      files.find(file => extension(file.name) === ext) ||
      files.find(file => exts.includes(extension(file.name)) && extension(file.name) !== 'md') ||
      files.find(file => extension(file.name) === 'json') ||
      files.find(file => extension(file.name) === 'md') ||
      files[files.length - 1];
    this.props.setEditingFile(editingFile);
  }

  // Docking: every arrangement change flows through here -
  // normalize, persist, and give Ace a resize once the new
  // geometry has settled (its ResizeObserver also catches it).
  handleDockChange(tree) {
    const dockTree = normalizeTree(tree);
    if (!dockTree) return;
    this.setState({ dockTree }, () => {
      this.persistDock();
      window.requestAnimationFrame(() => {
        if (this.codeEditorRef.current) this.codeEditorRef.current.handleResize();
      });
    });
  }

  persistDock() {
    saveDockStore({
      custom: this.state.customLayouts,
      current: this.state.dockTree,
    });
  }

  applyLayout(entry) {
    if (entry && entry.tree) this.handleDockChange(entry.tree);
  }

  saveCustomLayout(name) {
    const tree = JSON.parse(JSON.stringify(this.state.dockTree));
    this.setState(prev => ({
      customLayouts: [...prev.customLayouts.filter(layout => layout.name !== name), { name, tree }],
    }), () => this.persistDock());
  }

  deleteCustomLayout(name) {
    this.setState(prev => ({
      customLayouts: prev.customLayouts.filter(layout => layout.name !== name),
    }), () => this.persistDock());
  }

  togglePanel(panelId) {
    const { dockTree } = this.state;
    if (treePanels(dockTree).has(panelId)) {
      const next = removePanel(dockTree, panelId);
      if (next) this.handleDockChange(next);
    } else {
      this.handleDockChange(ensurePanel(dockTree, panelId));
    }
  }

  toggleNavigatorOpened() {
    this.togglePanel('navigator');
  }

  toggleAiPanelOpened() {
    this.togglePanel('ai');
  }

  handleClickTitleBar() {
    this.toggleNavigatorOpened();
  }

  renderPanel(panelId) {
    switch (panelId) {
      case 'navigator':
        return <Navigator/>;
      case 'doc':
        return <VisualizationViewer variant="doc" className={styles.visualization_viewer}/>;
      case 'viz':
        return <VisualizationViewer variant="viz" className={styles.visualization_viewer}/>;
      case 'code':
        return (
          <TabContainer hideTestPanel className={styles.editor_tab_container}>
            <CodeEditor ref={this.codeEditorRef}/>
          </TabContainer>
        );
      case 'tests':
        return <TestPanel/>;
      case 'ai':
        return <AiAssistant/>;
      default:
        return null;
    }
  }

  render() {
    const { dockTree, customLayouts } = this.state;
    const { titles, description, saved } = this.props.current;

    const title = `${saved ? '' : '(Unsaved) '}${titles.join(' - ')}`;
    const present = treePanels(dockTree);
    const navigatorOpened = present.has('navigator');
    const aiPanelOpened = present.has('ai');

    return (
      <div className={styles.app}>
        <Helmet>
          <title>{title}</title>
          <meta name="description" content={description}/>
        </Helmet>
        <Header className={styles.header} onClickTitleBar={this.handleClickTitleBar}
                navigatorOpened={navigatorOpened} loadScratchPapers={this.loadScratchPapers}
                aiPanelOpened={aiPanelOpened} onToggleAiPanel={() => this.toggleAiPanelOpened()}
                currentTree={dockTree}
                customLayouts={customLayouts}
                panelsPresent={[...present]}
                onTogglePanel={panelId => this.togglePanel(panelId)}
                onApplyLayout={entry => this.applyLayout(entry)}
                onSaveLayout={name => this.saveCustomLayout(name)}
                onDeleteLayout={name => this.deleteCustomLayout(name)}
                ignoreHistoryBlock={this.ignoreHistoryBlock}/>
        <DockWorkspace className={styles.workspace} tree={dockTree}
                       onChange={this.handleDockChange}
                       renderPanel={panelId => this.renderPanel(panelId)}/>
        <ToastContainer className={styles.toast_container}/>
      </div>
    );
  }
}

export default connect(({ current, env }) => ({ current, env }), actions)(
  App,
);
