import { useMemo, type ReactNode } from 'react';
import { parseBotText, type BotBlock, type BotInline } from './markdown';

/** The Bot's answer as text: the Discord Markdown subset becomes elements, never HTML. */
export function BotText({ text }: { text: string }) {
  const blocks = useMemo(() => parseBotText(text), [text]);
  return <div className="bot-text">{blocks.map((block, i) => renderBlock(block, i))}</div>;
}

function renderInline(parts: BotInline[]): ReactNode[] {
  return parts.map((part, i) => {
    if (part.kind === 'bold') return <strong key={i}>{part.text}</strong>;
    if (part.kind === 'link') {
      return (
        <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
          {part.text}
        </a>
      );
    }
    return <span key={i}>{part.text}</span>;
  });
}

function renderBlock(block: BotBlock, index: number): ReactNode {
  if (block.kind === 'small') return <p key={index} className="bot-small">{renderInline(block.inline)}</p>;
  if (block.kind === 'list') {
    return (
      <ul key={index} className="bot-list">
        {block.items.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  return (
    <p key={index}>
      {block.lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {renderInline(line)}
        </span>
      ))}
    </p>
  );
}
