import React from 'react';
import { toCanvas } from 'html-to-image';
import { BaseComponent, TracerStage } from 'components';
import {
  GIF_FRAME_MS,
  MAX_GIF_FRAMES,
  MAX_GIF_WIDTH,
  sampleFrameIndexes,
  sanitizeFileName,
  framePngName,
  imageEmbed,
  buildNoteMarkdown,
  encodeGif,
  buildBundleZip,
  downloadBlob,
} from 'common/gifExport';
import styles from './GifExport.module.scss';

// Records the current visualization as an animated GIF and
// bundles it with a Markdown note into a portable ZIP
// (note.md + <name>.gif), for notes taken outside this app.
// It also captures the single frame the player is sitting on
// (props.cursor) as a PNG — the same capture pipeline, one
// frame — with its own embed line, download button, and a slot
// in the ZIP.
//
// Capture replays the recorded chunks in an offscreen
// TracerStage (the same engine the embedded mini players use),
// one frame per sampled chunk cursor, and rasterizes each
// frame with html-to-image: the tracers render as React DOM
// (GraphTracer is SVG, Array/Log tracers are HTML divs), so
// there is no canvas to grab directly. Frames are encoded
// with gifenc (pure JS, no worker). The GIF plays at the
// embedded players' pace (one frame per 550 ms step).
//
// Props: chunks (required), title (note title / file slug
// source), cursor (the player's current frame, for the still
// image), onClose.
function waitPaint() {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.setTimeout(resolve, 30));
    });
  });
}

class GifExport extends BaseComponent {
  constructor(props) {
    super(props);
    this.state = {
      phase: 'recording', // 'recording' | 'done' | 'error'
      frame: 0,
      totalFrames: 0,
      gifUrl: null,
      gifBytes: 0,
      frameCount: 0,
      pngUrl: null,
      pngBytes: 0,
      pngName: '',
      frameCursor: 0,
      mdText: '',
      error: '',
      copied: false,
      pngCopied: false,
    };
    this.cancelled = false;
    this.stageRef = null;
    this.stageNode = null;
    this.zipBlob = null;
    this.gifBlob = null;
    this.pngBlob = null;
  }

  componentDidMount() {
    this.record();
  }

  componentWillUnmount() {
    this.cancelled = true;
    if (this.state.gifUrl) URL.revokeObjectURL(this.state.gifUrl);
    if (this.gifBlobUrl) URL.revokeObjectURL(this.gifBlobUrl);
    if (this.pngBlobUrl) URL.revokeObjectURL(this.pngBlobUrl);
  }

  // Rasterize the offscreen stage at one cursor: step it there,
  // wait for React to paint, then capture. Shared by the GIF
  // loop and the single-frame export.
  async captureFrame(cursor) {
    if (this.stageRef) {
      this.stageRef.seek(cursor);
      this.stageRef.setState({ cursor });
    }
    // eslint-disable-next-line no-await-in-loop
    await waitPaint();
    const node = this.stageNode;
    if (!node) throw new Error('The capture stage is not mounted.');
    const scale = Math.min(1, MAX_GIF_WIDTH / Math.max(1, node.offsetWidth));
    return toCanvas(node, { pixelRatio: scale });
  }

  async record() {
    const { chunks, title, cursor } = this.props;
    const total = (chunks || []).length;
    const indexes = sampleFrameIndexes(total, MAX_GIF_FRAMES);
    this.setState({ totalFrames: indexes.length });
    try {
      // The still frame first: the frame the player is sitting
      // on when the dialog opened (clamped to 1..total; cursor 0
      // is the empty stage). One rasterize, same pipeline as a
      // GIF frame, encoded as PNG.
      const frameCursor = Math.max(1, Math.min(cursor || total, total));
      const frameCanvas = await this.captureFrame(frameCursor);
      if (this.cancelled) return;
      const pngBlob = await new Promise((resolve, reject) => {
        frameCanvas.toBlob(
          blob => (blob ? resolve(blob) : reject(new Error('PNG encode failed.'))),
          'image/png',
        );
      });
      if (this.cancelled) return;
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      const slug = sanitizeFileName(title);
      const pngName = framePngName(slug, frameCursor);
      this.pngBlob = pngBlob;
      this.pngBlobUrl = URL.createObjectURL(pngBlob);
      this.setState({ pngUrl: this.pngBlobUrl, pngBytes: pngBytes.length, pngName, frameCursor });
      const frames = [];
      for (let k = 0; k < indexes.length; k += 1) {
        if (this.cancelled) return;
        // eslint-disable-next-line no-await-in-loop
        const canvas = await this.captureFrame(indexes[k]);
        if (this.cancelled) return;
        const ctx = canvas.getContext('2d');
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        frames.push({ data, width: canvas.width, height: canvas.height });
        this.setState({ frame: k + 1 });
      }
      if (this.cancelled) return;
      const gifBytes = encodeGif(frames, GIF_FRAME_MS);
      const gifName = `${slug}.gif`;
      const mdName = `${slug}.md`;
      const mdText = buildNoteMarkdown({ title, gifName, pngName, frameCursor, chunks });
      const zipBlob = await buildBundleZip({
        mdName,
        mdText,
        gifName,
        gifBytes,
        pngName,
        pngBytes,
        outputType: 'blob',
      });
      if (this.cancelled) return;
      this.zipBlob = zipBlob;
      this.gifBlob = new Blob([gifBytes], { type: 'image/gif' });
      this.gifBlobUrl = URL.createObjectURL(this.gifBlob);
      this.setState({
        phase: 'done',
        gifUrl: this.gifBlobUrl,
        gifBytes: gifBytes.length,
        frameCount: frames.length,
        mdText,
        mdName,
        gifName,
      });
    } catch (error) {
      if (!this.cancelled) {
        this.setState({ phase: 'error', error: (error && error.message) || 'Recording failed.' });
      }
    }
  }

  copySnippet() {
    const text = this.state.mdText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => this.setState({ copied: true }))
        .catch(() => {
          if (this.mdTextRef) this.mdTextRef.select();
        });
    } else if (this.mdTextRef) {
      // Clipboard API needs a secure context; on a plain-http
      // LAN address the box above is the fallback: select it
      // all so the user can copy with the keyboard.
      this.mdTextRef.select();
    }
  }

  downloadZip() {
    if (!this.zipBlob) return;
    downloadBlob(this.zipBlob, `${sanitizeFileName(this.props.title)}.zip`);
  }

  // The still-frame embed line only, e.g.
  // ![Hamiltonian Cycles — frame 12](hamiltonian-cycles-frame-12.png)
  frameEmbedLine() {
    const { pngName, frameCursor } = this.state;
    if (!pngName) return '';
    const label = frameCursor ? `${this.props.title} — frame ${frameCursor}` : this.props.title;
    return imageEmbed(label, pngName);
  }

  copyFrameEmbed() {
    const text = this.frameEmbedLine();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => this.setState({ pngCopied: true }))
        .catch(() => {
          if (this.mdTextRef) this.mdTextRef.select();
        });
    } else if (this.mdTextRef) {
      // Clipboard API needs a secure context; on a plain-http
      // LAN address the box above is the fallback: select it
      // all so the user can copy with the keyboard.
      this.mdTextRef.select();
    }
  }

  downloadPng() {
    if (!this.pngBlob) return;
    downloadBlob(this.pngBlob, this.state.pngName || 'frame.png');
  }

  render() {
    const { chunks, title, onClose } = this.props;
    const { phase, frame, totalFrames, gifUrl, gifBytes, frameCount,
      pngUrl, pngBytes, pngName, frameCursor, mdText, error, copied, pngCopied } = this.state;
    const slug = sanitizeFileName(title);
    return (
      <div className={styles.overlay} onClick={onClose}>
        <div className={styles.box} onClick={e => e.stopPropagation()}>
          <div className={styles.title}>Export animation as GIF + frame image + Markdown bundle</div>
          {
            phase === 'recording' ? (
              <div>
                <div className={styles.hint}>
                  Recording frame {frame} / {totalFrames} — the animation is replayed offscreen,
                  one frame per step. This can take a while for long animations.
                </div>
                <div className={styles.progress}>
                  <div className={styles.progress_bar}
                       style={{ width: `${totalFrames ? Math.round((frame / totalFrames) * 100) : 0}%` }}/>
                </div>
              </div>
            ) : phase === 'error' ? (
              <div>
                <div className={styles.error}>Recording failed: {error}</div>
                <div className={styles.hint}>
                  The GIF capture needs the visualization to render in the browser.
                  The header Export MD button still works for the in-app embed.
                </div>
              </div>
            ) : (
              <div>
                <div className={styles.hint}>
                  {frameCount} frames · {(gifBytes / 1024).toFixed(0)} KB GIF · loops forever.
                  The ZIP holds {slug}.md + {slug}.gif{pngName ? ` + ${pngName}` : ''} — unzip it
                  anywhere and the note works in any Markdown app; the note still plays inside
                  this app too.
                </div>
                {gifUrl ? <img className={styles.preview} src={gifUrl} alt="Animation preview"/> : null}
                {pngUrl ? (
                  <div>
                    <div className={styles.hint}>
                      Current frame (step {frameCursor} of {(chunks || []).length}) · {(pngBytes / 1024).toFixed(0)} KB PNG.
                      Embed it with: <code>{this.frameEmbedLine()}</code>
                    </div>
                    <img className={styles.preview} src={pngUrl} alt={`Frame ${frameCursor}`}/>
                  </div>
                ) : null}
                <div className={styles.hint}>Paste this into any .md note (or use the ZIP’s .md as-is):</div>
                <textarea className={styles.text} readOnly ref={ref => { this.mdTextRef = ref; }}
                          value={mdText} onClick={e => e.target.select()}/>
              </div>
            )
          }
          <div className={styles.row}>
            {
              phase === 'done' && pngUrl ? (
                <button className={styles.button} onClick={() => this.copyFrameEmbed()}>
                  {pngCopied ? '✓ Frame embed copied' : 'Copy frame embed'}
                </button>
              ) : null
            }
            {
              phase === 'done' && pngUrl ? (
                <button className={styles.button} onClick={() => this.downloadPng()}>
                  Download PNG
                </button>
              ) : null
            }
            {
              phase === 'done' ? (
                <button className={styles.button} onClick={() => this.copySnippet()}>
                  {copied ? '✓ Copied' : 'Copy Markdown'}
                </button>
              ) : null
            }
            {
              phase === 'done' ? (
                <button className={styles.button} onClick={() => this.downloadZip()}>
                  Download .zip
                </button>
              ) : null
            }
            <button className={styles.button} onClick={onClose}>
              {phase === 'recording' ? 'Cancel' : 'Close'}
            </button>
          </div>
        </div>
        {/* Offscreen capture stage: positioned off-viewport, never
            display:none (html-to-image needs layout). It replays the
            recorded chunks with the same engine the embedded mini
            players use. */}
        <div ref={ref => { this.stageNode = ref; }}
             style={{ position: 'fixed', left: -10000, top: 0, width: MAX_GIF_WIDTH }}>
          <TracerStage ref={ref => { this.stageRef = ref; }} bare static chunks={chunks || []}/>
        </div>
      </div>
    );
  }
}

export default GifExport;
