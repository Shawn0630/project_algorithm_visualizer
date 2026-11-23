// Screenshot attachments for the AI Assistant, ported from Finance
// Mate's AI chats: paste (Ctrl/Cmd+V) or attach an image and it
// rides to the model as an image part on that turn only.
//
// Storage shapes the processing. Sessions persist twice - in
// localStorage (2 MB total, pruned) and in the server's pad_chats
// table (messages capped at 2 MB JSON) - and the Test Cases chat
// persists in pad_tests (chat capped at 512 KB JSON). A raw retina
// screenshot is 1-3 MB as a data URL and would blow all three, so
// every image is downscaled before it is stored or sent: longest
// side 1200 px, JPEG 0.82, stepping down to 900 px / 0.75 and then
// 640 px / 0.7 until it fits 300 KB. Text in screenshots stays
// readable at 1200 px, and the model downsamples vision inputs
// anyway. An image that is already small keeps its original bytes
// (a PNG screenshot's crisp text is worth keeping), and a browser
// without canvas 2d keeps the original too.
export const MAX_ATTACHMENTS = 4;
export const MAX_TEST_ATTACHMENTS = 1;
export const MAX_IMAGE_BYTES = 300 * 1024;
export const MAX_IMAGE_DIMENSION = 1200;
// The server rejects an image over 5 MB; the client never lets one
// that big through, but a downscale that cannot shrink enough
// still has to stop somewhere.
export const HARD_IMAGE_BYTES = 1024 * 1024;

const DOWNSCALE_STEPS = [
  { size: 1200, quality: 0.82 },
  { size: 900, quality: 0.75 },
  { size: 640, quality: 0.7 },
];

export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

// Approximate decoded bytes of a data: URL (base64 inflates by 4/3).
export function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(body.replace(/=+$/, '').length * 3 / 4);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the image.'));
    image.src = dataUrl;
  });
}

// Downscale one data URL, or return it unchanged when it already
// fits, when the browser has no canvas 2d, or when the image will
// not decode (a 1 s load timeout covers the last two without
// hanging the send).
export async function downscaleImage(dataUrl) {
  if (dataUrlBytes(dataUrl) <= MAX_IMAGE_BYTES) return dataUrl;
  let image;
  try {
    image = await Promise.race([
      loadImage(dataUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('image load timed out')), 1000)),
    ]);
  } catch (error) {
    return dataUrl;
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  let best = null;
  for (const step of DOWNSCALE_STEPS) {
    const scale = Math.min(1, step.size / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const candidate = canvas.toDataURL('image/jpeg', step.quality);
    best = candidate;
    if (dataUrlBytes(candidate) <= MAX_IMAGE_BYTES) return candidate;
  }
  return best || dataUrl;
}

let attachmentCounter = 0;

export async function processImageFile(file) {
  if (!isImageFile(file)) throw new Error('Only images can be attached.');
  const dataUrl = await downscaleImage(await readFileAsDataUrl(file));
  if (dataUrlBytes(dataUrl) > HARD_IMAGE_BYTES) {
    throw new Error('That image is too large even after shrinking (max 1 MB).');
  }
  attachmentCounter += 1;
  return {
    id: `att-${Date.now()}-${attachmentCounter}`,
    name: file.name || 'screenshot.png',
    type: dataUrl.startsWith('data:image/png') ? 'image/png' : dataUrl.startsWith('data:image/gif') ? 'image/gif' : dataUrl.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg',
    dataUrl,
  };
}

// Process pasted / attached files against a per-message cap.
// Returns { added, errors }: non-images and over-cap files are
// reported, never silently dropped.
export async function processImageFiles(files, maxCount, existingCount = 0) {
  const added = [];
  const errors = [];
  for (const file of files || []) {
    if (added.length + existingCount >= maxCount) {
      errors.push(`At most ${maxCount} image${maxCount === 1 ? '' : 's'} per message.`);
      break;
    }
    try {
      added.push(await processImageFile(file));
    } catch (error) {
      errors.push(error && error.message ? error.message : 'Could not attach that image.');
    }
  }
  return { added, errors };
}

// The request payload for one turn's attachments: raw base64, no
// data: prefix - the server builds the image_url part from it
// (the same shape Finance Mate sends).
export function attachmentsToPayload(attachments) {
  return (attachments || []).map(attachment => ({
    name: attachment.name,
    type: attachment.type,
    data: attachment.dataUrl.split(',')[1] || '',
  }));
}

// The note a history turn carries for its images, so follow-ups
// still know a screenshot was part of the turn without resending
// its bytes.
export function imageNoteForHistory(images, imageNames) {
  const names = (images && images.length ? images.map(image => image.name) : imageNames) || [];
  if (!names.length) return '';
  return names.length === 1
    ? ` [Attached image: ${names[0]}]`
    : ` [Attached ${names.length} images: ${names.join(', ')}]`;
}

// The clipboard side of the Finance Mate pattern: a clipboard
// carrying files is a screenshot, not text.
export function filesFromPasteEvent(event) {
  return event && event.clipboardData ? [...event.clipboardData.files] : [];
}
