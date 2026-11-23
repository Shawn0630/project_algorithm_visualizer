import {
  MAX_ATTACHMENTS,
  MAX_TEST_ATTACHMENTS,
  isImageFile,
  dataUrlBytes,
  attachmentsToPayload,
  imageNoteForHistory,
  filesFromPasteEvent,
  processImageFile,
  processImageFiles,
} from './attachments';

// 1x1 transparent PNG, small enough to pass through downscaling
// untouched (jsdom has no canvas 2d, so only the small-file path
// is exercised here; the canvas path runs in a real browser).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageFile(name = 'shot.png') {
  const bytes = Uint8Array.from(atob(TINY_PNG_B64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  blob.name = name;
  return blob;
}

function textFile() {
  const blob = new Blob(['hello'], { type: 'text/plain' });
  blob.name = 'notes.txt';
  return blob;
}

describe('isImageFile', () => {
  it('accepts image/* and rejects everything else', () => {
    expect(isImageFile({ type: 'image/png' })).toBe(true);
    expect(isImageFile({ type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ type: 'text/plain' })).toBe(false);
    expect(isImageFile({ type: 'application/pdf' })).toBe(false);
    expect(isImageFile(null)).toBe(false);
    expect(isImageFile({})).toBe(false);
  });
});

describe('dataUrlBytes', () => {
  it('measures decoded bytes, not base64 length', () => {
    // 'aGVsbG8=' decodes to 'hello' (5 bytes).
    expect(dataUrlBytes('data:text/plain;base64,aGVsbG8=')).toBe(5);
    expect(dataUrlBytes(`data:image/png;base64,${TINY_PNG_B64}`)).toBe(70);
  });
});

describe('attachmentsToPayload', () => {
  it('sends raw base64 with name and type, like Finance Mate', () => {
    const payload = attachmentsToPayload([
      { name: 'shot.png', type: 'image/png', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    ]);
    expect(payload).toEqual([{ name: 'shot.png', type: 'image/png', data: TINY_PNG_B64 }]);
    expect(attachmentsToPayload([])).toEqual([]);
    expect(attachmentsToPayload(null)).toEqual([]);
  });
});

describe('imageNoteForHistory', () => {
  it('names one image, counts several, and stays empty without any', () => {
    expect(imageNoteForHistory([{ name: 'a.png' }])).toBe(' [Attached image: a.png]');
    expect(imageNoteForHistory([{ name: 'a.png' }, { name: 'b.png' }]))
      .toBe(' [Attached 2 images: a.png, b.png]');
    expect(imageNoteForHistory([], ['old.png'])).toBe(' [Attached image: old.png]');
    expect(imageNoteForHistory([])).toBe('');
    expect(imageNoteForHistory(null, null)).toBe('');
  });
});

describe('filesFromPasteEvent', () => {
  it('takes the files off a clipboard event and tolerates a missing one', () => {
    const file = imageFile();
    expect(filesFromPasteEvent({ clipboardData: { files: [file] } })).toEqual([file]);
    expect(filesFromPasteEvent({ clipboardData: { files: [] } })).toEqual([]);
    expect(filesFromPasteEvent(null)).toEqual([]);
    expect(filesFromPasteEvent({})).toEqual([]);
  });
});

describe('processImageFile', () => {
  it('keeps a small screenshot as-is, with its name and type', async () => {
    const attachment = await processImageFile(imageFile('problem.png'));
    expect(attachment.name).toBe('problem.png');
    expect(attachment.type).toBe('image/png');
    expect(attachment.dataUrl).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
    expect(typeof attachment.id).toBe('string');
  });

  it('rejects a non-image', async () => {
    await expect(processImageFile(textFile())).rejects.toThrow('Only images can be attached.');
  });
});

describe('processImageFiles', () => {
  it('adds images, reports non-images, and enforces the per-message cap', async () => {
    const { added, errors } = await processImageFiles(
      [imageFile('a.png'), textFile(), imageFile('b.png')],
      MAX_ATTACHMENTS,
    );
    expect(added.map(a => a.name)).toEqual(['a.png', 'b.png']);
    expect(errors).toEqual(['Only images can be attached.']);
  });

  it('stops at the cap and says so', async () => {
    const { added, errors } = await processImageFiles(
      [imageFile('a.png'), imageFile('b.png')],
      MAX_TEST_ATTACHMENTS,
    );
    expect(added.map(a => a.name)).toEqual(['a.png']);
    expect(errors).toEqual(['At most 1 image per message.']);
  });

  it('counts already-queued attachments against the cap', async () => {
    const { added, errors } = await processImageFiles([imageFile('c.png')], MAX_TEST_ATTACHMENTS, 1);
    expect(added).toEqual([]);
    expect(errors).toEqual(['At most 1 image per message.']);
  });
});
