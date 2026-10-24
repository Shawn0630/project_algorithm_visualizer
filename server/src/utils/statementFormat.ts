// Formats a hand-pasted LeetCode statement into Markdown for the
// admin import box. Two paste shapes arrive from the browser:
//   - rich paste from the LeetCode page itself carries HTML, which
//     the existing converter handles;
//   - plain-text paste (from a PDF, a mirror site, or the problem
//     page's text) loses every tag, so the structure has to be
//     rebuilt from LeetCode's textual conventions: "Example N:"
//     sections whose Input/Output/Explanation lines belong in one
//     fenced block (the same shape the HTML converter produces
//     from <pre>), a "Constraints:" section whose lines are
//     bullets, and bolded Follow-up/Note labels.
// Already-Markdown text is recognized and only lightly cleaned -
// reflowing it would mangle hand-written READMEs.

import { htmlToMarkdown } from 'utils/htmlToMarkdown';

const EXAMPLE_LABEL = /^Example\s+\d+\s*:?\s*$/;
const EXAMPLE_FIELD = /^(Input|Output|Explanation)\s*:/;
const SECTION_LABEL = /^(Constraints|Follow-up|Note)\s*:\s*(.*)$/;

export function looksLikeHtml(text: string): boolean {
  return /<(p|pre|div|ul|ol|li|strong|b|em|code|br|h[1-6])[\s>]/i.test(text);
}

export function plainTextToMarkdown(raw: string): string {
  const source = String(raw || '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
  // Already Markdown (or carrying code fences): normalize blank
  // lines and trailing space only, never reflow the content.
  if (source.includes('```') || /^#{1,6}\s/m.test(source)) {
    return source
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const lines = source.split('\n').map(line => line.replace(/[ \t]+$/g, ''));
  const out: string[] = [];
  let i = 0;
  const pushBlank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      pushBlank();
      i += 1;
      continue;
    }

    // Example section: bold the label, then fence the run of
    // Input/Output/Explanation lines that follows it.
    if (EXAMPLE_LABEL.test(trimmed)) {
      pushBlank();
      out.push(`**${trimmed.replace(/:?$/, ':')}**`);
      i += 1;
      // Skip blank lines between the label and its fields.
      while (i < lines.length && !lines[i].trim()) i += 1;
      const fields: string[] = [];
      while (i < lines.length && EXAMPLE_FIELD.test(lines[i].trim())) {
        fields.push(lines[i].trim());
        i += 1;
      }
      if (fields.length) {
        out.push('', '```', ...fields, '```');
      }
      pushBlank();
      continue;
    }

    // Constraints: bold the label, bullet every following
    // non-blank line until the section ends.
    const section = trimmed.match(SECTION_LABEL);
    if (section && section[1] === 'Constraints') {
      pushBlank();
      out.push('**Constraints:**');
      if (section[2]) out.push(`- ${section[2]}`);
      i += 1;
      while (i < lines.length && lines[i].trim()) {
        // Strip an existing bullet marker (marker + space) -
        // never a leading minus on a negative number.
        const item = lines[i].trim().replace(/^[-•*]\s+/, '');
        out.push(`- ${item}`);
        i += 1;
      }
      pushBlank();
      continue;
    }
    if (section) {
      // Follow-up / Note: bold just the label, keep the text.
      pushBlank();
      out.push(`**${section[1]}:**${section[2] ? ` ${section[2]}` : ''}`);
      i += 1;
      continue;
    }

    // Standalone Input/Output lines outside an example keep a
    // bold label instead of a fence.
    if (EXAMPLE_FIELD.test(trimmed) && !/^\*\*/.test(trimmed)) {
      out.push(trimmed.replace(/^(Input|Output|Explanation)\s*:/, '**$1:**'));
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Entry point for the endpoint: HTML wins when the paste carried
// it; HTML pasted AS text (copied source) is detected; anything
// else goes through the plain-text formatter.
export function formatStatement(input: { html?: string; text?: string }): string {
  const html = typeof input.html === 'string' ? input.html : '';
  const text = typeof input.text === 'string' ? input.text : '';
  if (html.trim()) return htmlToMarkdown(html);
  if (text.trim() && looksLikeHtml(text)) return htmlToMarkdown(text);
  return plainTextToMarkdown(text);
}
