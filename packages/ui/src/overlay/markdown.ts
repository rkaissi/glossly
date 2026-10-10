// A small Markdown subset for Ask answers: paragraphs, headings, bullet and numbered lists,
// fenced code, inline code, and bold. It is rendered as React elements (never as HTML) and must
// tolerate a half-streamed answer, such as an unclosed code fence.

export type Inline = { t: 'text' | 'code' | 'bold'; v: string };

export type Block =
  | { t: 'p'; inl: Inline[] }
  | { t: 'h'; inl: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'code'; v: string };

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  for (const part of s.split(INLINE)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) out.push({ t: 'code', v: part.slice(1, -1) });
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) out.push({ t: 'bold', v: part.slice(2, -2) });
    else out.push({ t: 'text', v: part });
  }
  return out;
}

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: string[] } | null = null;
  let code: string[] | null = null;

  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inl: parseInline(para.join('\n')) });
    if (list) blocks.push({ t: list.t, items: list.items.map(parseInline) });
    para = [];
    list = null;
  };

  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (code) {
      if (FENCE.test(line)) {
        blocks.push({ t: 'code', v: code.join('\n') });
        code = null;
      } else code.push(line);
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ t: 'h', inl: parseInline(h[1]!) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    const item = b ?? n;
    if (item) {
      const t = b ? 'ul' : 'ol';
      if (para.length || (list && list.t !== t)) flush();
      list ??= { t, items: [] };
      list.items.push(item[1]!);
      continue;
    }
    // A continuation line of a list item.
    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    para.push(line);
  }
  if (code) blocks.push({ t: 'code', v: code.join('\n') });
  flush();
  return blocks;
}
