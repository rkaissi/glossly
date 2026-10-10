import { useMemo } from 'react';
import { parseMarkdown, type Inline } from './markdown';

function Inlines({ inl }: { inl: Inline[] }) {
  return (
    <>
      {inl.map((x, i) => (x.t === 'code' ? <code key={i}>{x.v}</code> : x.t === 'bold' ? <strong key={i}>{x.v}</strong> : x.v))}
    </>
  );
}

/** An Ask answer rendered from the Markdown subset in markdown.ts. */
export function AnswerText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p':
            return (
              <p key={i}>
                <Inlines inl={b.inl} />
              </p>
            );
          case 'h':
            return (
              <h3 key={i}>
                <Inlines inl={b.inl} />
              </h3>
            );
          case 'code':
            return (
              <pre key={i}>
                <code>{b.v}</code>
              </pre>
            );
          default: {
            const List = b.t;
            return (
              <List key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines inl={item} />
                  </li>
                ))}
              </List>
            );
          }
        }
      })}
    </>
  );
}
