// Minimal HTML -> Markdown converter for LeetCode problem
// statements (their content HTML uses a small, regular tag subset:
// p, pre, code, strong, em, ul/ol/li, sup/sub, a, img and entities).
// It only has to be good enough for the admin import preview - the
// AI formatting pass (or a hand edit) polishes from there.

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&le;/g, '≤')
    .replace(/&ge;/g, '≥')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

export function htmlToMarkdown(html: string): string {
  let text = String(html || '');

  // Protect <pre> blocks (example inputs/outputs) from the inline
  // rewriting below; they come back as fenced code blocks.
  const preBlocks: string[] = [];
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (match, inner) => {
    preBlocks.push(decodeEntities(stripTags(String(inner))).replace(/^\n+|\n+$/g, ''));
    return `\n\n\u0001${preBlocks.length - 1}\u0002\n\n`;
  });

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|ul|ol|blockquote|table|tr|h[1-6])>/gi, '\n\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/(li)>/gi, '');
  text = text.replace(/<h([1-6])[^>]*>/gi, (match, level) => `\n\n${'#'.repeat(Number(level))} `);
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, '^($1)');
  text = text.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, '_($1)');
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[image: $1]');
  text = text.replace(/<img[^>]*>/gi, '');
  text = stripTags(text);
  text = decodeEntities(text);

  text = text.replace(/\u0001(\d+)\u0002/g, (match, index) => '```\n' + preBlocks[Number(index)] + '\n```');
  text = text.split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
