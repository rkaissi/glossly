// Text read from other apps carries artifacts: U+FFFC where an image, icon, or emoji sat
// (shown as "OBJ"), zero-width and other invisible characters, non-breaking spaces, Windows
// line endings, trailing spaces, and runs of blank lines. cleanText removes those and keeps
// everything else as written: line breaks, lists, indentation, column spacing, and the words.

const chars = (...codes: number[]) => String.fromCodePoint(...codes);

/** Where an embedded image, icon, or emoji was. Windows shows it as a boxed "OBJ". */
const OBJECT_CHAR = chars(0xfffc);
/** Zero-width space, word joiner, byte order mark, soft hyphen, replacement character. Joiners and direction marks stay. */
const INVISIBLE = new RegExp(`[${chars(0x200b, 0x2060, 0xfeff, 0xad, 0xfffd)}]`, 'g');
const OBJECT = new RegExp(`[ \\t]*${OBJECT_CHAR}+[ \\t]*`, 'g');
/** Non-breaking and narrow non-breaking space (Chrome writes "10:42 AM" with the narrow one). */
const HARD_SPACE = new RegExp(`[${chars(0xa0, 0x202f)}]`, 'g');
/** Unicode line and paragraph separators. */
const SEPARATOR = new RegExp(`[${chars(0x2028, 0x2029)}]`, 'g');

export function cleanText(text: string, opts: { trimEdges?: boolean } = {}): string {
  let t = text
    .replace(/\r\n?/g, '\n')
    .replace(SEPARATOR, '\n')
    // An object between two words leaves one space; at the start or end of a line, none.
    .replace(OBJECT, (m: string, at: number, all: string) => {
      const end = at + m.length;
      const edge = at === 0 || all[at - 1] === '\n' || end === all.length || all[end] === '\n';
      return edge || !/[ \t]/.test(m) ? '' : ' ';
    })
    .replace(INVISIBLE, '')
    .replace(HARD_SPACE, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  if (opts.trimEdges ?? true) t = t.replace(/^\n+/, '').replace(/\s+$/, '');
  return t;
}
