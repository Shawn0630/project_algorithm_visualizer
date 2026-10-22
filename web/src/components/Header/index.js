import React from 'react';
import { connect } from 'react-redux';
import { withRouter } from 'react-router';
import AutosizeInput from 'react-input-autosize';
import screenfull from 'screenfull';
import Promise from 'bluebird';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import faAngleRight from '@fortawesome/fontawesome-free-solid/faAngleRight';
import faCaretDown from '@fortawesome/fontawesome-free-solid/faCaretDown';
import faCaretRight from '@fortawesome/fontawesome-free-solid/faCaretRight';
import faCodeBranch from '@fortawesome/fontawesome-free-solid/faCodeBranch';
import faExpandArrowsAlt from '@fortawesome/fontawesome-free-solid/faExpandArrowsAlt';
import faCog from '@fortawesome/fontawesome-free-solid/faCog';
import faBook from '@fortawesome/fontawesome-free-solid/faBook';
import faComments from '@fortawesome/fontawesome-free-solid/faComments';
import faGithub from '@fortawesome/fontawesome-free-brands/faGithub';
import faTrashAlt from '@fortawesome/fontawesome-free-solid/faTrashAlt';
import faSave from '@fortawesome/fontawesome-free-solid/faSave';
import faFacebook from '@fortawesome/fontawesome-free-brands/faFacebook';
import { GitHubApi } from 'apis';
import { classes, refineGist } from 'common/util';
import { actions } from 'reducers';
import { BaseComponent, Button, Ellipsis, LayoutsMenu, ListItem, Player } from 'components';
import styles from './Header.module.scss';

class Header extends BaseComponent {
  constructor(props) {
    super(props);
    // Which breadcrumb dropdown is open: 'source' | 'section' |
    // 'problem' | null.
    this.state = { openCrumb: null };
  }

  componentWillReceiveProps(nextProps) {
    // Navigating (from a crumb menu, the Navigator, anywhere)
    // closes any open crumb dropdown.
    if (nextProps.location !== this.props.location) {
      this.setState({ openCrumb: null });
    }
  }

  toggleCrumb(name) {
    this.setState(prev => ({ openCrumb: prev.openCrumb === name ? null : name }));
  }

  closeCrumbs() {
    this.setState({ openCrumb: null });
  }

  goToProblem(categoryKey, algorithmKey) {
    this.closeCrumbs();
    this.props.history.push(`/${categoryKey}/${algorithmKey}`);
  }

  // The breadcrumb data for the current problem page: the source
  // (the category type, e.g. Algorithm / LeetCode), the sections
  // of that source, and the problems of the current section.
  crumbData() {
    const { categories } = this.props.directory || {};
    const { algorithm } = this.props.current;
    if (!algorithm || !categories || !categories.length) return null;
    // Prefer the category that actually contains the current
    // problem (section keys are only unique per source in
    // practice, and the Navigator's two tabs can hold same-named
    // sections).
    const currentCategory = categories.find(c => c.key === algorithm.categoryKey
      && (c.algorithms || []).some(a => a.key === algorithm.algorithmKey))
      || categories.find(c => c.key === algorithm.categoryKey);
    if (!currentCategory) return null;
    const types = [];
    categories.forEach(c => { if (!types.includes(c.type)) types.push(c.type); });
    // A problem's difficulty rides along as one of its tags
    // (exactly one of Easy / Medium / Hard - the import flow
    // and the admin save both enforce that); surface it as a
    // pill next to the problem title in the title bar.
    const tagNames = categories
      .filter(c => c.type === currentCategory.type && (c.algorithms || []).some(a => a.key === algorithm.algorithmKey))
      .map(c => c.name);
    const difficulty = ['Easy', 'Medium', 'Hard'].find(d => tagNames.includes(d)) || null;
    return {
      types,
      type: currentCategory.type,
      difficulty,
      currentCategory,
      sections: categories.filter(c => c.type === currentCategory.type),
      problems: currentCategory.algorithms || [],
      currentProblem: (currentCategory.algorithms || []).find(a => a.key === algorithm.algorithmKey),
    };
  }

  selectSource(type, data) {
    if (type === data.type) return this.closeCrumbs();
    const { categories } = this.props.directory;
    const first = categories.find(c => c.type === type && c.algorithms && c.algorithms.length)
      || categories.find(c => c.type === type);
    if (first && first.algorithms && first.algorithms.length) {
      this.goToProblem(first.key, first.algorithms[0].key);
    } else {
      this.closeCrumbs();
    }
  }

  selectSection(category) {
    if (category.algorithms && category.algorithms.length) {
      this.goToProblem(category.key, category.algorithms[0].key);
    } else {
      this.closeCrumbs();
    }
  }

  renderCrumb(name, label, items) {
    const open = this.state.openCrumb === name;
    return (
      <span className={styles.crumb_wrap} key={name}>
        <button type="button" className={styles.crumb} onClick={() => this.toggleCrumb(name)}>
          <Ellipsis>{label}</Ellipsis>
          <FontAwesomeIcon className={styles.crumb_caret} fixedWidth icon={faCaretDown}/>
        </button>
        {open && (
          <div className={styles.crumb_menu}>
            {items.map(item => (
              <div key={item.key} className={classes(styles.crumb_item, item.selected && styles.crumb_item_selected)}
                   onClick={item.onSelect}>
                <Ellipsis>{item.label}</Ellipsis>
                {item.hint && <span className={styles.crumb_hint}>{item.hint}</span>}
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  handleClickFullScreen() {
    if (screenfull.enabled) {
      if (screenfull.isFullscreen) {
        screenfull.exit();
      } else {
        screenfull.request();
      }
    }
  }

  handleChangeTitle(e) {
    const { value } = e.target;
    this.props.modifyTitle(value);
  }

  saveGist() {
    const { user } = this.props.env;
    const { scratchPaper, titles, files, lastFiles, editingFile } = this.props.current;
    const gist = {
      description: titles[titles.length - 1],
      files: {},
    };
    files.forEach(file => {
      gist.files[file.name] = {
        content: file.content,
      };
    });
    lastFiles.forEach(lastFile => {
      if (!(lastFile.name in gist.files)) {
        gist.files[lastFile.name] = null;
      }
    });
    gist.files['algorithm-visualizer'] = {
      content: 'https://algorithm-visualizer.org/',
    };
    const save = gist => {
      if (!user) return Promise.reject(new Error('Sign In Required'));
      if (scratchPaper && scratchPaper.login) {
        if (scratchPaper.login === user.login) {
          return GitHubApi.editGist(scratchPaper.gistId, gist);
        } else {
          return GitHubApi.forkGist(scratchPaper.gistId).then(forkedGist => GitHubApi.editGist(forkedGist.id, gist));
        }
      }
      return GitHubApi.createGist(gist);
    };
    save(gist)
      .then(refineGist)
      .then(newScratchPaper => {
        this.props.setScratchPaper(newScratchPaper);
        this.props.setEditingFile(newScratchPaper.files.find(file => file.name === editingFile.name));
        if (!(scratchPaper && scratchPaper.gistId === newScratchPaper.gistId)) {
          this.props.history.push(`/scratch-paper/${newScratchPaper.gistId}`);
        }
      })
      .then(this.props.loadScratchPapers)
      .catch(this.handleError);
  }

  hasPermission() {
    const { scratchPaper } = this.props.current;
    const { user } = this.props.env;
    if (!scratchPaper) return false;
    if (scratchPaper.gistId !== 'new') {
      if (!user) return false;
      if (scratchPaper.login !== user.login) return false;
    }
    return true;
  }

  deleteGist() {
    const { scratchPaper } = this.props.current;
    const { gistId } = scratchPaper;
    if (gistId === 'new') {
      this.props.ignoreHistoryBlock(() => this.props.history.push('/'));
    } else {
      GitHubApi.deleteGist(gistId)
        .then(() => {
          this.props.ignoreHistoryBlock(() => this.props.history.push('/'));
        })
        .then(this.props.loadScratchPapers)
        .catch(this.handleError);
    }
  }

  render() {
    const { className, onClickTitleBar, navigatorOpened } = this.props;
    const { scratchPaper, titles, saved } = this.props.current;
    const { user } = this.props.env;
    const crumb = this.crumbData();

    const permitted = this.hasPermission();

    return (
      <header className={classes(styles.header, className)}>
        <div className={styles.row}>
          <div className={styles.section}>
            {crumb ? (
              // Breadcrumb navigation: source (Algorithm /
              // LeetCode) > section > problem, each segment a
              // dropdown for switching at that level. Switching
              // the source or a section lands on its first
              // section's / that section's first problem. The
              // caret at the end still toggles the full Navigator.
              <div className={styles.title_bar}>
                {this.renderCrumb('source', crumb.type, crumb.types.map(t => ({
                  key: t,
                  label: t,
                  selected: t === crumb.type,
                  onSelect: () => this.selectSource(t, crumb),
                })))}
                <FontAwesomeIcon className={styles.nav_arrow} fixedWidth icon={faAngleRight}/>
                {this.renderCrumb('section', crumb.currentCategory.name, crumb.sections.map(c => ({
                  key: c.key,
                  label: c.name,
                  hint: `${(c.algorithms || []).length}`,
                  selected: c.key === crumb.currentCategory.key,
                  onSelect: () => this.selectSection(c),
                })))}
                <FontAwesomeIcon className={styles.nav_arrow} fixedWidth icon={faAngleRight}/>
                {this.renderCrumb('problem', crumb.currentProblem ? crumb.currentProblem.name : (titles[1] || ''), crumb.problems.map(a => ({
                  key: a.key,
                  label: a.name,
                  selected: !!crumb.currentProblem && a.key === crumb.currentProblem.key,
                  onSelect: () => this.goToProblem(crumb.currentCategory.key, a.key),
                })))}
                {crumb.difficulty && (
                  <span className={classes(styles.difficulty, styles[`difficulty_${crumb.difficulty.toLowerCase()}`])}>
                    {crumb.difficulty}
                  </span>
                )}
                <Button className={styles.nav_toggle} onClick={onClickTitleBar}>
                  <FontAwesomeIcon fixedWidth icon={navigatorOpened ? faCaretDown : faCaretRight}/>
                </Button>
              </div>
            ) : (
              <Button className={styles.title_bar} onClick={onClickTitleBar}>
                {
                  titles.map((title, i) => [
                    scratchPaper && i === 1 ?
                      <AutosizeInput className={styles.input_title} key={`title-${i}`} value={title}
                                     onClick={e => e.stopPropagation()} onChange={e => this.handleChangeTitle(e)}/> :
                      <Ellipsis key={`title-${i}`}>{title}</Ellipsis>,
                    i < titles.length - 1 &&
                    <FontAwesomeIcon className={styles.nav_arrow} fixedWidth icon={faAngleRight} key={`arrow-${i}`}/>,
                  ])
                }
                <FontAwesomeIcon className={styles.nav_caret} fixedWidth
                                 icon={navigatorOpened ? faCaretDown : faCaretRight}/>
              </Button>
            )}
            {this.state.openCrumb && <div className={styles.crumb_overlay} onClick={() => this.closeCrumbs()}/>}
          </div>
          <div className={styles.section}>
            {/* <Button icon={permitted ? faSave : faCodeBranch} primary disabled={permitted && saved}
                    onClick={() => this.saveGist()}>{permitted ? 'Save' : 'Fork'}</Button>
            {
              permitted &&
              <Button icon={faTrashAlt} primary onClick={() => this.deleteGist()} confirmNeeded>Delete</Button>
            } */}
            {/* <Button icon={faFacebook} primary
                    href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`}>Share</Button> */}
            <LayoutsMenu currentLayout={this.props.currentLayout} customLayouts={this.props.customLayouts}
                         onApplyLayout={this.props.onApplyLayout} onSaveLayout={this.props.onSaveLayout}
                         onDeleteLayout={this.props.onDeleteLayout}/>
            <Button icon={faComments} primary selected={this.props.aiPanelOpened}
                    onClick={() => this.props.onToggleAiPanel && this.props.onToggleAiPanel()}>AI Assistant</Button>
            <Button icon={faBook} primary to="/license">License</Button>
            <Button icon={faExpandArrowsAlt} primary
                    onClick={() => this.handleClickFullScreen()}>Fullscreen</Button>
            <Button icon={faCog} primary href="/api/admin">Admin</Button>
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.section}>
            {/* {
              user ?
                <Button className={styles.btn_dropdown} icon={user.avatar_url}>
                  {user.login}
                  <div className={styles.dropdown}>
                    <ListItem label="Sign Out" href="/api/auth/destroy" rel="opener"/>
                  </div>
                </Button> :
                <Button icon={faGithub} primary href="/api/auth/request" rel="opener">
                  <Ellipsis>Sign In</Ellipsis>
                </Button>
            } */}
          </div>
          <Player className={styles.section}/>
        </div>
      </header>
    );
  }
}

export default withRouter(
  connect(({ current, env, directory }) => ({ current, env, directory }), actions)(
    Header,
  ),
);

