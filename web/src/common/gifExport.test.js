import JSZip from 'jszip';
import {
  GIF_FRAME_MS,
  MAX_GIF_FRAMES,
  visualizationSnippet,
  sampleFrameIndexes,
  sanitizeFileName,
  framePngName,
  imageEmbed,
  buildNoteMarkdown,
  encodeGif,
  normalizeGifFrames,
  buildBundleZip,
  clampFrameCursor,
} from './gifExport';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A stand-in for real canvas.toBlob PNG bytes: the 8-byte PNG
// signature plus payload. The real encoder output is verified
// in a headless browser (see ~/workspace/av-verify/frame-export-/).
function fakePngBytes() {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = new Uint8Array(PNG_SIGNATURE.length + payload.length);
  out.set(PNG_SIGNATURE, 0);
  out.set(payload, PNG_SIGNATURE.length);
  return out;
}

function pngHeader(bytes) {
  return Array.from(bytes.subarray(0, 8));
}

function rgbaFrame(width, height, r, g, b) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function gifHeader(bytes) {
  return String.fromCharCode(...bytes.subarray(0, 6));
}

describe('visualizationSnippet', () => {
  it('wraps the chunks as a fenced visualization block', () => {
    const chunks = [{ commands: [] }, { commands: [{ key: null, method: 'setRoot', args: [] }] }];
    const snippet = visualizationSnippet(chunks);
    expect(snippet.startsWith('```visualization\n')).toBe(true);
    expect(snippet.endsWith('\n```')).toBe(true);
    const parsed = JSON.parse(snippet.slice('```visualization\n'.length, -4));
    expect(parsed.v).toBe(1);
    expect(parsed.chunks).toEqual(chunks);
  });
});

describe('sampleFrameIndexes', () => {
  it('keeps every step for short animations', () => {
    expect(sampleFrameIndexes(5)).toEqual([1, 2, 3, 4, 5]);
    expect(sampleFrameIndexes(1)).toEqual([1]);
    expect(sampleFrameIndexes(0)).toEqual([]);
  });

  it('samples long animations down to the cap, always ending on the final frame', () => {
    const indexes = sampleFrameIndexes(1000, MAX_GIF_FRAMES);
    expect(indexes.length).toBeLessThanOrEqual(MAX_GIF_FRAMES);
    expect(indexes[0]).toBe(1);
    expect(indexes[indexes.length - 1]).toBe(1000);
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });

  it('uses the 550 ms frame pace', () => {
    expect(GIF_FRAME_MS).toBe(550);
  });
});

describe('clampFrameCursor', () => {
  it('keeps a cursor inside 1..total and reads cursor 0 as the final frame', () => {
    expect(clampFrameCursor(3, 18)).toBe(3);
    expect(clampFrameCursor(1, 18)).toBe(1);
    expect(clampFrameCursor(18, 18)).toBe(18);
    expect(clampFrameCursor(0, 18)).toBe(18);
    expect(clampFrameCursor(99, 18)).toBe(18);
    expect(clampFrameCursor(-2, 18)).toBe(1);
  });

  it('falls back to 1 when there are no frames', () => {
    expect(clampFrameCursor(3, 0)).toBe(1);
    expect(clampFrameCursor(0, 0)).toBe(1);
  });
});

describe('sanitizeFileName', () => {
  it('slugifies titles', () => {
    expect(sanitizeFileName('Hamiltonian Cycles!')).toBe('hamiltonian-cycles');
    expect(sanitizeFileName('  Fraud / Detection  ')).toBe('fraud-detection');
    expect(sanitizeFileName('code.java')).toBe('code-java');
  });

  it('falls back for empty input', () => {
    expect(sanitizeFileName('')).toBe('visualization');
    expect(sanitizeFileName('!!!')).toBe('visualization');
  });
});

describe('framePngName', () => {
  it('names the still image <slug>-frame-<cursor>.png', () => {
    expect(framePngName('hamiltonian-cycles', 12)).toBe('hamiltonian-cycles-frame-12.png');
    expect(framePngName('Hamiltonian Cycles!', 1)).toBe('hamiltonian-cycles-frame-1.png');
  });

  it('clamps the cursor to at least 1 and falls back for an empty slug', () => {
    expect(framePngName('hamiltonian-cycles', 0)).toBe('hamiltonian-cycles-frame-1.png');
    expect(framePngName('', 3)).toBe('visualization-frame-3.png');
  });
});

describe('imageEmbed', () => {
  it('builds a relative Markdown image embed', () => {
    expect(imageEmbed('Hamiltonian Cycles', 'hamiltonian-cycles.gif'))
      .toBe('![Hamiltonian Cycles](hamiltonian-cycles.gif)');
    expect(imageEmbed('Hamiltonian Cycles — frame 12', 'hamiltonian-cycles-frame-12.png'))
      .toBe('![Hamiltonian Cycles — frame 12](hamiltonian-cycles-frame-12.png)');
  });
});

describe('buildNoteMarkdown', () => {
  it('embeds the GIF relatively and keeps the in-app visualization block', () => {
    const chunks = [{ commands: [] }];
    const md = buildNoteMarkdown({ title: 'Hamiltonian Cycles', gifName: 'hamiltonian-cycles.gif', chunks });
    expect(md).toContain('# Hamiltonian Cycles');
    expect(md).toContain('![Hamiltonian Cycles](hamiltonian-cycles.gif)');
    expect(md).toContain('```visualization');
    const fence = md.slice(md.indexOf('```visualization\n') + '```visualization\n'.length);
    expect(JSON.parse(fence.slice(0, fence.indexOf('\n```'))).chunks).toEqual(chunks);
  });

  it('adds the frame PNG embed line after the GIF line when a frame was captured', () => {
    const chunks = [{ commands: [] }];
    const md = buildNoteMarkdown({
      title: 'Hamiltonian Cycles',
      gifName: 'hamiltonian-cycles.gif',
      pngName: 'hamiltonian-cycles-frame-12.png',
      frameCursor: 12,
      chunks,
    });
    expect(md).toContain('![Hamiltonian Cycles — frame 12](hamiltonian-cycles-frame-12.png)');
    expect(md.indexOf('hamiltonian-cycles.gif')).toBeLessThan(md.indexOf('hamiltonian-cycles-frame-12.png'));
    expect(md.indexOf('hamiltonian-cycles-frame-12.png')).toBeLessThan(md.indexOf('```visualization'));
  });

  it('omits the frame line entirely when no frame was captured', () => {
    const chunks = [{ commands: [] }];
    const md = buildNoteMarkdown({ title: 'Hamiltonian Cycles', gifName: 'hamiltonian-cycles.gif', chunks });
    expect(md).not.toContain('.png');
  });
});

describe('encodeGif', () => {
  it('encodes frames into a valid looping GIF', () => {
    const bytes = encodeGif([rgbaFrame(8, 8, 255, 0, 0), rgbaFrame(8, 8, 0, 0, 255)]);
    expect(gifHeader(bytes)).toBe('GIF89a');
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('is deterministic for the same frames', () => {
    const frames = [rgbaFrame(4, 4, 1, 2, 3)];
    expect(encodeGif(frames)).toEqual(encodeGif(frames));
  });

  it('rejects an empty frame list and frames without a size', () => {
    expect(() => encodeGif([])).toThrow('No frames');
    expect(() => encodeGif([{ data: new Uint8Array(0) }])).toThrow('width and height');
    expect(() => encodeGif([rgbaFrame(4, 4, 0, 0, 0), { data: new Uint8Array(0) }]))
      .toThrow('width and height');
  });

  it('encodes mixed-size frames instead of throwing', () => {
    const bytes = encodeGif([rgbaFrame(4, 4, 255, 0, 0), rgbaFrame(8, 6, 0, 0, 255)]);
    expect(gifHeader(bytes)).toBe('GIF89a');
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('sizes the GIF to the largest frame', () => {
    const bytes = encodeGif([
      rgbaFrame(4, 4, 255, 0, 0),
      rgbaFrame(8, 6, 0, 0, 255),
      rgbaFrame(2, 10, 0, 255, 0),
    ]);
    // Logical screen size: bytes 6-7 width, 8-9 height, little-endian.
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    expect(width).toBe(8);
    expect(height).toBe(10);
  });
});

describe('normalizeGifFrames', () => {
  // A frame built from explicit pixels: map "x,y" -> [r, g, b, a].
  // Unlisted pixels start as transparent black.
  function pixelFrame(width, height, pixels) {
    const data = new Uint8ClampedArray(width * height * 4);
    Object.entries(pixels).forEach(([key, [r, g, b, a]]) => {
      const [x, y] = key.split(',').map(Number);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    });
    return { data, width, height };
  }

  function pixelAt(frame, x, y) {
    const i = (y * frame.width + x) * 4;
    return Array.from(frame.data.subarray(i, i + 4));
  }

  it('pads smaller frames to the max size, content anchored top-left', () => {
    const small = pixelFrame(2, 2, { '0,0': [255, 0, 0, 255], '1,1': [0, 255, 0, 255] });
    const big = pixelFrame(4, 3, { '0,0': [0, 0, 255, 255] });
    const [outSmall, outBig] = normalizeGifFrames([small, big]);
    expect(outSmall.width).toBe(4);
    expect(outSmall.height).toBe(3);
    // The distinctly-coloured (0,0) pixel survives at the top-left.
    expect(pixelAt(outSmall, 0, 0)).toEqual([255, 0, 0, 255]);
    // The (1,1) pixel survives in place.
    expect(pixelAt(outSmall, 1, 1)).toEqual([0, 255, 0, 255]);
    // Padding below/right is the frame's own background (its (0,0) red).
    expect(pixelAt(outSmall, 3, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(outSmall, 0, 2)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(outSmall, 3, 2)).toEqual([255, 0, 0, 255]);
    // A frame already at the target size passes through unchanged.
    expect(outBig).toBe(big);
  });

  it('fills padding with opaque black when the (0,0) pixel is transparent', () => {
    const small = pixelFrame(2, 2, { '1,0': [0, 255, 0, 255] });
    const big = pixelFrame(4, 4, { '0,0': [0, 0, 255, 255] });
    const [outSmall] = normalizeGifFrames([small, big]);
    expect(outSmall.width).toBe(4);
    expect(outSmall.height).toBe(4);
    expect(pixelAt(outSmall, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(outSmall, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(outSmall, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it('leaves same-size frames untouched', () => {
    const a = rgbaFrame(4, 4, 9, 9, 9);
    const b = rgbaFrame(4, 4, 1, 2, 3);
    expect(normalizeGifFrames([a, b])).toEqual([a, b]);
  });
});

describe('buildBundleZip', () => {
  it('zips note.md + the GIF with the GIF bytes intact', async () => {
    const gifBytes = encodeGif([rgbaFrame(4, 4, 9, 9, 9)]);
    const mdText = '# T\n\n![T](t.gif)\n';
    const out = await buildBundleZip({
      mdName: 't.md',
      mdText,
      gifName: 't.gif',
      gifBytes,
      outputType: 'uint8array',
    });
    const zip = await JSZip.loadAsync(out);
    expect(Object.keys(zip.files).sort()).toEqual(['t.gif', 't.md']);
    expect(await zip.file('t.md').async('string')).toBe(mdText);
    const gifBack = await zip.file('t.gif').async('uint8array');
    expect(gifHeader(gifBack)).toBe('GIF89a');
    expect(gifBack.length).toBe(gifBytes.length);
  });

  it('adds the frame PNG with its bytes intact when one was captured', async () => {
    const gifBytes = encodeGif([rgbaFrame(4, 4, 9, 9, 9)]);
    const pngBytes = fakePngBytes();
    const mdText = '# T\n\n![T](t.gif)\n\n![T — frame 2](t-frame-2.png)\n';
    const out = await buildBundleZip({
      mdName: 't.md',
      mdText,
      gifName: 't.gif',
      gifBytes,
      pngName: 't-frame-2.png',
      pngBytes,
      outputType: 'uint8array',
    });
    const zip = await JSZip.loadAsync(out);
    expect(Object.keys(zip.files).sort()).toEqual(['t-frame-2.png', 't.gif', 't.md']);
    const pngBack = await zip.file('t-frame-2.png').async('uint8array');
    expect(pngHeader(pngBack)).toEqual(PNG_SIGNATURE);
    expect(pngBack.length).toBe(pngBytes.length);
    expect(Array.from(pngBack)).toEqual(Array.from(pngBytes));
  });

  it('stays a two-file bundle when no frame was captured', async () => {
    const gifBytes = encodeGif([rgbaFrame(4, 4, 9, 9, 9)]);
    const out = await buildBundleZip({
      mdName: 't.md',
      mdText: '# T\n',
      gifName: 't.gif',
      gifBytes,
      outputType: 'uint8array',
    });
    const zip = await JSZip.loadAsync(out);
    expect(Object.keys(zip.files).sort()).toEqual(['t.gif', 't.md']);
  });
});
