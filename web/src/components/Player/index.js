import React from 'react';
import { connect } from 'react-redux';
import InputRange from 'react-input-range';
import axios from 'axios';
import faPlay from '@fortawesome/fontawesome-free-solid/faPlay';
import faChevronLeft from '@fortawesome/fontawesome-free-solid/faChevronLeft';
import faChevronRight from '@fortawesome/fontawesome-free-solid/faChevronRight';
import faPause from '@fortawesome/fontawesome-free-solid/faPause';
import faWrench from '@fortawesome/fontawesome-free-solid/faWrench';
import { classes, extension, VISUALIZE_CASE_EVENT } from 'common/util';
import { TracerApi } from 'apis';
import { actions } from 'reducers';
import { BaseComponent, Button, ProgressBar } from 'components';
import styles from './Player.module.scss';

// The Markdown embed for the current visualization: a fenced
// block holding the recorded chunks as JSON. Pasted into any
// .md file in the app, the doc renderer plays it as an embedded
// animation (see VisualizationViewer's splitDoc).
export function visualizationSnippet(chunks) {
  return '```visualization\n' + JSON.stringify({ v: 1, chunks }) + '\n```';
}
const errorMessage = error => {
  if (error && error.response) {
    const { data, statusText } = error.response;
    return data ? (typeof data === 'string' ? data : JSON.stringify(data)) : (statusText || 'Unknown error');
  }
  return (error && error.message) || 'Unknown error';
};

class Player extends BaseComponent {
  constructor(props) {
    super(props);

    this.state = {
      speed: 2,
      playing: false,
      building: false,
      exportOpen: false,
      copied: false,
    };

    this.tracerApiSource = null;

    this.reset();
  }

  componentDidMount() {
    const { editingFile, shouldBuild } = this.props.current;
    if (shouldBuild) this.build(editingFile);
    // The Testcase panel's Visualize action hands over a wrapped
    // source (pad code + a harness for one case): build it like a
    // pad build, then play it.
    this.handleVisualizeCase = event => {
      const detail = (event && event.detail) || {};
      if (typeof detail.code === 'string') {
        this.runBuild(detail.code, extension(detail.name || ''), true);
      }
    };
    window.addEventListener(VISUALIZE_CASE_EVENT, this.handleVisualizeCase);
  }

  componentWillUnmount() {
    if (this.handleVisualizeCase) window.removeEventListener(VISUALIZE_CASE_EVENT, this.handleVisualizeCase);
    this.pause();
  }

  componentWillReceiveProps(nextProps) {
    const { editingFile, shouldBuild } = nextProps.current;
    if (editingFile !== this.props.current.editingFile) {
      if (shouldBuild) this.build(editingFile);
    }
  }

  reset(commands = []) {
    const chunks = [{
      commands: [],
      lineNumber: undefined,
    }];
    while (commands.length) {
      const command = commands.shift();
      const { key, method, args } = command;
      if (key === null && method === 'delay') {
        const [lineNumber] = args;
        chunks[chunks.length - 1].lineNumber = lineNumber;
        chunks.push({
          commands: [],
          lineNumber: undefined,
        });
      } else {
        chunks[chunks.length - 1].commands.push(command);
      }
    }
    this.props.setChunks(chunks);
    this.props.setCursor(0);
    this.pause();
    this.props.setLineIndicator(undefined);
  }

  build(file) {
    if (!file) {
      this.reset();
      this.props.setBuildError(null);
      return;
    }
    // Markdown notes are not runnable: the doc pane previews the
    // note being edited, and the player's current visualization
    // must survive note edits untouched.
    if (extension(file.name) === 'md') {
      this.props.setBuildError(null);
      return;
    }
    this.runBuild(file.content, extension(file.name), false);
  }

  // Shared build path: the pad's own Build (autoplay off) and the
  // Testcase panel's case visualizations (autoplay on).
  runBuild(code, ext, autoplay) {
    this.reset();
    this.props.setBuildError(null);

    if (this.tracerApiSource) this.tracerApiSource.cancel();
    this.tracerApiSource = axios.CancelToken.source();
    this.setState({ building: true });

    if (ext in TracerApi) {
      TracerApi[ext]({ code }, undefined, this.tracerApiSource.token)
        .then(commands => {
          this.tracerApiSource = null;
          this.setState({ building: false });
          this.reset(commands);
          if (autoplay) this.resume(true);
          else this.next();
        })
        .catch(error => {
          if (axios.isCancel(error)) return;
          this.tracerApiSource = null;
          this.setState({ building: false });
          // Build errors go to the panel under the code pad (copyable
          // text), not to a toast.
          this.props.setBuildError(errorMessage(error));
        });
    } else {
      this.setState({ building: false });
      this.props.setBuildError('Language Not Supported');
    }
  }

  isValidCursor(cursor) {
    const { chunks } = this.props.player;
    return 1 <= cursor && cursor <= chunks.length;
  }

  prev() {
    this.pause();
    const cursor = this.props.player.cursor - 1;
    if (!this.isValidCursor(cursor)) return false;
    this.props.setCursor(cursor);
    return true;
  }

  resume(wrap = false) {
    this.pause();
    if (this.next() || (wrap && this.props.setCursor(1))) {
      const interval = 4000 / Math.pow(Math.E, this.state.speed);
      this.timer = window.setTimeout(() => this.resume(), interval);
      this.setState({ playing: true });
    }
  }

  pause() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
      this.setState({ playing: false });
    }
  }

  next() {
    this.pause();
    const cursor = this.props.player.cursor + 1;
    if (!this.isValidCursor(cursor)) return false;
    this.props.setCursor(cursor);
    return true;
  }

  handleChangeSpeed(speed) {
    this.setState({ speed });
  }

  copySnippet(snippet) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(snippet)
        .then(() => this.setState({ copied: true }))
        .catch(() => {
          if (this.exportTextRef) this.exportTextRef.select();
        });
    } else if (this.exportTextRef) {
      // Clipboard API needs a secure context; on a plain-http LAN
      // address the box above is the fallback: select it all so
      // the user can copy with the keyboard.
      this.exportTextRef.select();
    }
  }

  handleChangeProgress(progress) {
    const { chunks } = this.props.player;
    const cursor = Math.max(1, Math.min(chunks.length, Math.round(progress * chunks.length)));
    this.pause();
    this.props.setCursor(cursor);
  }

  render() {
    const { className } = this.props;
    const { editingFile } = this.props.current;
    const { chunks, cursor } = this.props.player;
    const { speed, playing, building } = this.state;

    return (
      <div className={classes(styles.player, className)}>
        <Button icon={faWrench} primary disabled={building} inProgress={building}
                onClick={() => this.build(editingFile)}>
          {building ? 'Building' : 'Build'}
        </Button>
        {
          playing ? (
            <Button icon={faPause} primary active onClick={() => this.pause()}>Pause</Button>
          ) : (
            <Button icon={faPlay} primary onClick={() => this.resume(true)}>Play</Button>
          )
        }
        <Button icon={faChevronLeft} primary disabled={!this.isValidCursor(cursor - 1)} onClick={() => this.prev()}/>
        <ProgressBar className={styles.progress_bar} current={cursor} total={chunks.length}
                     onChangeProgress={progress => this.handleChangeProgress(progress)}/>
        <Button icon={faChevronRight} reverse primary disabled={!this.isValidCursor(cursor + 1)}
                onClick={() => this.next()}/>
        <div className={styles.speed}>
          Speed
          <InputRange
            classNames={{
              inputRange: styles.range,
              labelContainer: styles.range_label_container,
              slider: styles.range_slider,
              track: styles.range_track,
            }} minValue={0} maxValue={4} step={.5} value={speed}
            onChange={speed => this.handleChangeSpeed(speed)}/>
        </div>
        <Button primary disabled={chunks.length <= 1}
                onClick={() => this.setState({ exportOpen: true, copied: false })}>
          Export MD
        </Button>
        {
          this.state.exportOpen ? (
            <div className={styles.export_overlay} onClick={() => this.setState({ exportOpen: false })}>
              <div className={styles.export_box} onClick={e => e.stopPropagation()}>
                <div className={styles.export_title}>Embed this visualization in Markdown</div>
                <div className={styles.export_hint}>
                  Paste this block into any .md note in the app — the Description pane plays it as an
                  animation. ({Math.max(1, Math.round(visualizationSnippet(chunks).length / 1024))} KB)
                </div>
                <textarea className={styles.export_text} readOnly ref={ref => { this.exportTextRef = ref; }}
                          value={visualizationSnippet(chunks)} onClick={e => e.target.select()}/>
                <div className={styles.export_row}>
                  <button className={styles.export_button} onClick={() => this.copySnippet(visualizationSnippet(chunks))}>
                    {this.state.copied ? '✓ Copied' : 'Copy'}
                  </button>
                  <button className={styles.export_button} onClick={() => this.setState({ exportOpen: false })}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null
        }
      </div>
    );
  }
}

export default connect(({ current, player }) => ({ current, player }), actions)(
  Player,
);
