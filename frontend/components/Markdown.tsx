"use client";

import type { ReactNode } from "react";
import { safeHref } from "../lib/safe";

// Minimal, dependency-free Markdown renderer for draft bodies + council output.
// Handles the subset the writer emits: paragraphs, #/##/### headings, - / * and
// numbered lists, plus inline **bold**, *italic*, `code` and [links](url).
// Builds real React nodes (no dangerouslySetInnerHTML), so it is XSS-safe.

const INLINE_RE =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (!part) return null;
    if (/^\*\*[\s\S]+\*\*$/.test(part) || /^__[\s\S]+__$/.test(part))
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part))
      return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(part))
      return <code key={key}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      // Unsafe scheme (javascript:/data:/…) -> render as plain text, no link.
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {link[1]}
        </a>
      ) : (
        <span key={key}>{link[1]}</span>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

export default function Markdown({ text }: { text: string }) {
  const lines = (text || "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length; // 1..3 -> md-h1..md-h3
      blocks.push(
        <div key={`h-${k++}`} className={`md-h md-h${level}`}>
          {renderInline(heading[2], `h${k}`)}
        </div>,
      );
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(
          <li key={`li-${k}-${items.length}`}>
            {renderInline(lines[i].replace(/^\s*[-*]\s+/, ""), `ul${k}-${items.length}`)}
          </li>,
        );
        i++;
      }
      blocks.push(<ul key={`ul-${k++}`} className="md-ul">{items}</ul>);
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(
          <li key={`oli-${k}-${items.length}`}>
            {renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ""), `ol${k}-${items.length}`)}
          </li>,
        );
        i++;
      }
      blocks.push(<ol key={`ol-${k++}`} className="md-ol">{items}</ol>);
      continue;
    }

    // Paragraph — gather consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i].trim()) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={`p-${k++}`} className="md-p">
        {renderInline(para.join(" "), `p${k}`)}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
