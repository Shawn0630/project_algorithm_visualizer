// GIF + ZIP-bundle export of a recorded visualization.
//
// A visualization is an array of chunks (the same shape the main
// Player holds). This module holds everything about the export
// that does not need the DOM: the ```visualization Markdown
// snippet (also used by the Player's Export MD dialog), the
// frame plan, the note Markdown, the GIF encoder and the ZIP
// bundle assembly. The DOM capture itself (stepping a TracerStage
// and rasterizing it) lives in components/GifExport, which feeds
// raw RGBA frames to encodeGif here.
//
// The bundle is a ZIP because browsers cannot download a raw
// folder: it holds note.md + <name>.gif, and the .md embeds the
// GIF with a relative path, so the unzipped folder is portable
// to any Markdown app. The ```visualization block is kept in the
// .md too, so the note still plays inside this app. A single
// frame can be exported the same way: framePngName names the
// still image, its embed line goes in the .md after the GIF
// line, and the PNG rides in the ZIP (the PNG bytes themselves
// come from the browser's canvas.toBlob in components/GifExport).
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import JSZip from 'jszip';

// One GIF frame per chunk step, at the same pace the embedded
// mini players play (TracerStage steps every 550 ms).
export const GIF_FRAME_MS = 550;
// A full-length animation is hundreds of frames; sampling keeps
// the GIF (and the recording time) bounded.
export const MAX_GIF_FRAMES = 240;
// Captures are downscaled to this width; height follows aspect.
export const MAX_GIF_WIDTH = 720;

// The Markdown embed for the current visualization: a fenced
// block holding the recorded chunks as JSON. Pasted into any
// .md file in the app, the doc renderer plays it as an embedded
// animation (see VisualizationViewer's splitDoc).
export function visualizationSnippet(chunks) {
  return '```visualization\n' + JSON.stringify({ v: 1, chunks }) + '\n```';
}

// Chunk cursors to capture as GIF frames: cursors run 1..total
// (cursor 0 is the empty stage, before any command ran). Short
// animations keep every step; long ones are sampled evenly, and
// the final frame is always included.
export function sampleFrameIndexes(total, cap = MAX_GIF_FRAMES) {
  const n = Math.max(0, Math.floor(total) || 0);
  if (n <= 0) return [];
  if (n <= cap) {
    const out = [];
    for (let i = 1; i <= n; i += 1) out.push(i);
    return out;
  }
  const out = [];
  for (let k = 0; k < cap; k += 1) {
    out.push(Math.min(n, 1 + Math.round((k * (n - 1)) / (cap - 1))));
  }
  // Rounding can repeat an index at the seam; dedupe, keeping
  // the final frame.
  const deduped = out.filter((v, i) => i === 0 || v !== out[i - 1]);
  if (deduped[deduped.length - 1] !== n) deduped.push(n);
  return deduped;
}

// A frame cursor is 1-based (cursor 0 is the empty stage,
// before any command ran). Clamp an arbitrary cursor into
// 1..total; cursor 0 reads as the final frame, matching the
// GIF dialog's still-frame rule.
export function clampFrameCursor(cursor, total) {
  const n = Math.max(0, Math.floor(total) || 0);
  return Math.max(1, Math.min(Math.floor(cursor) || n, n));
}

// A filename-safe slug: lowercase, runs of anything but
// [a-z0-9] become one dash, trimmed. Falls back to
// 'visualization' for empty input.
export function sanitizeFileName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'visualization';
}

// The still-image file for one frame: <slug>-frame-<cursor>.png.
// Cursor is 1-based (cursor 0 is the empty stage, before any
// command ran), matching the GIF frame numbering.
export function framePngName(slug, cursor) {
  const n = Math.max(1, Math.floor(cursor) || 1);
  return `${sanitizeFileName(slug)}-frame-${n}.png`;
}

// A Markdown image embed with a relative path, portable to any
// Markdown app.
export function imageEmbed(title, fileName) {
  return `![${String(title || 'Visualization')}](${fileName})`;
}

// The note's Markdown: a title, the GIF embedded with a
// relative path (portable to any Markdown app), then the
// ```visualization block so the note still plays inside this
// app when opened here. When a frame PNG is given (pngName +
// frameCursor), its embed line follows the GIF line, so the
// still image shows in any Markdown app too.
export function buildNoteMarkdown({ title, gifName, pngName, frameCursor, chunks }) {
  const safeTitle = String(title || 'Visualization');
  const lines = [`# ${safeTitle}`, '', imageEmbed(safeTitle, gifName)];
  if (pngName) {
    const frameLabel = frameCursor ? `${safeTitle} — frame ${frameCursor}` : safeTitle;
    lines.push('', imageEmbed(frameLabel, pngName));
  }
  lines.push('', visualizationSnippet(chunks), '');
  return lines.join('\n');
}

// Pad RGBA frames to one shared size — the largest width and
// height across the list — so they encode as a single GIF.
// Content stays anchored top-left; the padding takes the frame's
// own background colour, sampled from its (0,0) pixel (opaque
// black when that pixel is fully transparent). Frames already
// at the target size pass through unchanged. This is what the
// capture stage needs: its container has a fixed width but its
// height follows the content at each step, so frames come back
// at different heights.
export function normalizeGifFrames(frames) {
  const list = frames || [];
  let width = 0;
  let height = 0;
  for (const f of list) {
    width = Math.max(width, f.width || 0);
    height = Math.max(height, f.height || 0);
  }
  return list.map(frame => {
    if (frame.width === width && frame.height === height) return frame;
    const src = frame.data || [];
    const bg = [src[0] || 0, src[1] || 0, src[2] || 0, src[3] || 0];
    const fill = bg[3] === 0 ? [0, 0, 0, 255] : bg;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = fill[0];
      data[i * 4 + 1] = fill[1];
      data[i * 4 + 2] = fill[2];
      data[i * 4 + 3] = fill[3];
    }
    for (let y = 0; y < frame.height; y += 1) {
      const srcRow = y * frame.width * 4;
      const dstRow = y * width * 4;
      data.set(src.subarray(srcRow, srcRow + frame.width * 4), dstRow);
    }
    return { data, width, height };
  });
}

// Encode RGBA frames into an animated GIF. frames are
// { data: Uint8Array|Uint8ClampedArray (RGBA), width, height }.
// Frames of different sizes are padded to the largest size
// (see normalizeGifFrames) instead of failing; delayMs is the
// per-frame delay; the GIF loops forever.
export function encodeGif(frames, delayMs = GIF_FRAME_MS) {
  const list = frames || [];
  if (!list.length) throw new Error('No frames to encode.');
  for (const f of list) {
    if (!f.width || !f.height) throw new Error('Frames need a width and height.');
  }
  const normalized = normalizeGifFrames(list);
  const { width, height } = normalized[0];
  const encoder = GIFEncoder();
  normalized.forEach((frame, i) => {
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    encoder.writeFrame(index, width, height, {
      palette,
      delay: delayMs,
      ...(i === 0 ? { repeat: 0 } : {}),
    });
  });
  encoder.finish();
  return encoder.bytes();
}

// Assemble the portable bundle: note.md + the GIF, plus the
// frame PNG when one was captured (pngName + pngBytes). Returns
// a Promise of the requested output ('blob' for downloading in
// the browser, 'uint8array' for tests).
export async function buildBundleZip({ mdName, mdText, gifName, gifBytes, pngName, pngBytes, outputType = 'blob' }) {
  const zip = new JSZip();
  zip.file(mdName, mdText);
  zip.file(gifName, gifBytes);
  if (pngName && pngBytes) zip.file(pngName, pngBytes);
  return zip.generateAsync({ type: outputType });
}

// Trigger a browser download of a Blob.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
