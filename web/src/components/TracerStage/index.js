import React from 'react';
import { BaseComponent } from 'components';
import * as TracerClasses from 'core/tracers';
import * as LayoutClasses from 'core/layouts';
import styles from './TracerStage.module.scss';

// A self-contained mini player for one recorded visualization
// (an array of chunks, the same shape the main Player holds).
// It runs its own tracer engine - the same command application
// as VisualizationViewer, but with local objects and cursor - so
// any number of stages can live inside a rendered Markdown doc
// (exported ```visualization embeds) without touching the main
// player's state.
//
// Props: chunks (required), autoplay (start playing on mount),
// controls (show the restart / play-pause / scrubber bar),
// static (render the final frame only - for Markdown segments).
class TracerStage extends BaseComponent {
  constructor(props) {
    super(props);
    this.state = { cursor: 0, playing: false };
    this.objects = {};
    this.root = null;
    this.timer = null;
  }

  componentDidMount() {
    const total = this.total();
    if (this.props.static || !this.props.autoplay) {
      this.seek(total);
      if (this.props.static) this.setState({ cursor: total });
    } else {
      this.seek(0);
      this.play();
    }
  }

  componentDidUpdate(prevProps) {
    if (prevProps.chunks !== this.props.chunks) {
      this.pause();
      const total = this.total();
      this.seek(this.props.static ? total : 0);
      this.setState({ cursor: this.props.static ? total : 0 }, () => {
        if (this.props.autoplay && !this.props.static) this.play();
      });
    }
  }

  componentWillUnmount() {
    this.pause();
  }

  total() {
    return (this.props.chunks || []).length;
  }

  reset() {
    this.objects = {};
    this.root = null;
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
        this.objects[key] = new LayoutClass(key, k => this.objects[k], children);
      } else if (method in TracerClasses) {
        const className = method;
        const [title = className] = args;
        const TracerClass = TracerClasses[className];
        this.objects[key] = new TracerClass(key, k => this.objects[k], title);
      } else {
        this.objects[key][method](...args);
      }
    } catch (error) {
      // One bad command must not take the whole doc down.
      console.error(error);
    }
  }

  // Rebuild from scratch up to (not including) chunk `cursor`:
  // embeds are small, and a rebuild is always consistent, unlike
  // the main viewer's incremental application.
  seek(cursor) {
    this.reset();
    const chunks = this.props.chunks || [];
    for (let i = 0; i < cursor && i < chunks.length; i += 1) {
      (chunks[i].commands || []).forEach(command => this.applyCommand(command));
    }
  }

  play() {
    this.pause();
    this.setState({ playing: true });
    const step = () => {
      this.timer = window.setTimeout(() => {
        if (this.state.cursor >= this.total()) {
          // Hold the final frame briefly, then loop.
          this.timer = window.setTimeout(() => {
            this.seek(0);
            this.setState({ cursor: 0 }, step);
          }, 1400);
          return;
        }
        const cursor = this.state.cursor + 1;
        this.seek(cursor);
        this.setState({ cursor }, step);
      }, 550);
    };
    step();
  }

  pause() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state.playing) this.setState({ playing: false });
  }

  togglePlay() {
    if (this.state.playing) {
      this.pause();
    } else {
      if (this.state.cursor >= this.total()) {
        this.seek(0);
        this.setState({ cursor: 0 }, () => this.play());
      } else {
        this.play();
      }
    }
  }

  scrub(value) {
    this.pause();
    const cursor = Number(value);
    this.seek(cursor);
    this.setState({ cursor });
  }

  render() {
    const { controls, static: isStatic, bare } = this.props;
    const total = this.total();
    const { cursor, playing } = this.state;
    return (
      <div className={bare ? `${styles.stage} ${styles.bare}` : styles.stage}>
        <div className={styles.screen}>
          {this.root ? this.root.render() : <div className={styles.empty}>No visualization</div>}
        </div>
        {
          controls && !isStatic && total > 0 ? (
            <div className={styles.controls}>
              <button className={styles.control_button} onClick={() => this.togglePlay()}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button className={styles.control_button}
                      onClick={() => { this.pause(); this.seek(0); this.setState({ cursor: 0 }); }}>
                ⏮ Restart
              </button>
              <input className={styles.scrubber} type="range" min={0} max={total} step={1}
                     value={cursor} onChange={e => this.scrub(e.target.value)}/>
              <span className={styles.step_label}>{cursor} / {total}</span>
            </div>
          ) : null
        }
      </div>
    );
  }
}

export default TracerStage;
