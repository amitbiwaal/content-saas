"use client";

import { useEffect, useRef } from "react";
import type { DraftSection } from "../lib/types";
import { safeHref } from "../lib/safe";

// A single WYSIWYG editor for the whole article: every section (heading + body)
// renders as one continuous, formatted, editable document. Content is stored as
// Markdown sections — this component converts sections <-> HTML so editing feels
// like a document while the backend keeps its Markdown model.

// ----- Markdown -> HTML (initial render) ----------------------------------- //
function esc(s: string): string {
  // Escape quotes too so an interpolated URL/alt cannot break out of an HTML
  // attribute (the output is assigned to innerHTML — attribute-injection XSS).
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The URL is already esc()'d by inlineToHtml; validate its scheme so a
// javascript:/data: target becomes an inert "#" rather than an executable link.
function attrUrl(escapedUrl: string): string {
  return safeHref(escapedUrl) ? escapedUrl : "#";
}

function inlineToHtml(text: string): string {
  let t = esc(text);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => `<img src="${attrUrl(url)}" alt="${alt}" />`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `<a href="${attrUrl(url)}">${label}</a>`);
  return t;
}

function mdBodyToHtml(md: string): string {
  // Strip stray ```lang code-fence markers (models sometimes wrap prose in them)
  // without dropping the surrounding text — keep only the words.
  const lines = (md || "").replace(/```[a-zA-Z0-9]*/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(t)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, "")); i++;
      }
      out.push(`<blockquote>${inlineToHtml(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineToHtml(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i++;
      }
      out.push(`<ul>${items.join("")}</ul>`); continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineToHtml(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`); i++;
      }
      out.push(`<ol>${items.join("")}</ol>`); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^[-*]\s+/.test(lines[i].trim()) && !/^\d+[.)]\s+/.test(lines[i].trim())) {
      para.push(lines[i].trim()); i++;
    }
    out.push(`<p>${inlineToHtml(para.join(" "))}</p>`);
  }
  return out.join("");
}

function sectionsToHtml(sections: DraftSection[]): string {
  return sections
    .map((s) => {
      const tag = s.level === 3 ? "h3" : "h2";
      return `<${tag}>${esc(s.heading || "")}</${tag}>${mdBodyToHtml(s.markdown)}`;
    })
    .join("");
}

// ----- HTML -> Markdown (on edit) ------------------------------------------ //
function inlineNodeToMd(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  if (el.tagName === "IMG") {
    return `![${el.getAttribute("alt") || ""}](${el.getAttribute("src") || ""})`;
  }
  const inner = Array.from(el.childNodes).map(inlineNodeToMd).join("");
  switch (el.tagName) {
    case "STRONG": case "B": return `**${inner}**`;
    case "EM": case "I": return `*${inner}*`;
    case "S": case "STRIKE": case "DEL": return `~~${inner}~~`;
    case "CODE": return "`" + inner + "`";
    case "A": return `[${inner}](${el.getAttribute("href") || ""})`;
    case "BR": return "\n";
    default: return inner;
  }
}

function blockToMd(el: HTMLElement): string {
  const tag = el.tagName;
  if (tag === "HR") return "---";
  if (tag === "UL") return Array.from(el.children).map((li) => `- ${inlineNodeToMd(li)}`).join("\n");
  if (tag === "OL") return Array.from(el.children).map((li, i) => `${i + 1}. ${inlineNodeToMd(li)}`).join("\n");
  if (tag === "BLOCKQUOTE") return `> ${inlineNodeToMd(el).trim()}`;
  return inlineNodeToMd(el).trim();
}

function htmlToSections(root: HTMLElement): DraftSection[] {
  const secs: { heading: string; level: number; blocks: string[] }[] = [];
  let cur: { heading: string; level: number; blocks: string[] } | null = null;
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && /^H[1-3]$/.test((node as HTMLElement).tagName)) {
      const el = node as HTMLElement;
      cur = { heading: (el.textContent || "").trim(), level: el.tagName === "H3" ? 3 : 2, blocks: [] };
      secs.push(cur);
    } else {
      if (!cur) { cur = { heading: "", level: 2, blocks: [] }; secs.push(cur); }
      const md = node.nodeType === Node.ELEMENT_NODE ? blockToMd(node as HTMLElement) : (node.textContent || "").trim();
      if (md.trim()) cur.blocks.push(md);
    }
  });
  return secs
    .filter((s) => s.heading || s.blocks.length)
    .map((s) => ({ heading: s.heading, level: s.level, markdown: s.blocks.join("\n\n") }));
}

const cmd = (name: string, value?: string) => document.execCommand(name, false, value);

export default function RichArticleEditor({
  initial,
  seedKey,
  onChange,
}: {
  initial: DraftSection[];
  seedKey: number;          // bump to re-seed the editor from `initial` (external edits)
  onChange: (sections: DraftSection[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed / re-seed innerHTML only on mount or external replacement (proofread,
  // regenerate, image) — never on the user's own keystrokes, so the caret holds.
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sectionsToHtml(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  function handleInput() {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      if (ref.current) onChange(htmlToSections(ref.current));
    }, 350);
  }

  function link() {
    const url = safeHref(window.prompt("Link URL"));
    if (url) cmd("createLink", url);
    handleInput();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); cmd("bold"); handleInput(); }
    else if (k === "i") { e.preventDefault(); cmd("italic"); handleInput(); }
    else if (k === "k") { e.preventDefault(); link(); }
  }

  const tb = (name: string, value?: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    cmd(name, value);
    handleInput();
  };

  function inlineCode() {
    const text = window.getSelection()?.toString() || "";
    cmd("insertHTML", `<code>${esc(text || "code")}</code>`);
    handleInput();
  }

  function image() {
    const url = safeHref(window.prompt("Image URL"));
    if (!url) return;
    const alt = window.prompt("Alt text (optional)") || "";
    cmd("insertHTML", `<img src="${esc(url)}" alt="${esc(alt)}" />`);
    handleInput();
  }

  return (
    <div className="rt-wrap">
      <div className="rt-toolbar">
        <button className="rt-btn" title="Heading 2" onMouseDown={tb("formatBlock", "H2")}>H2</button>
        <button className="rt-btn" title="Heading 3" onMouseDown={tb("formatBlock", "H3")}>H3</button>
        <button className="rt-btn" title="Body text" onMouseDown={tb("formatBlock", "P")}>¶</button>
        <button className="rt-btn" title="Quote" onMouseDown={tb("formatBlock", "BLOCKQUOTE")}>&ldquo;</button>
        <span className="rt-sep" />
        <button className="rt-btn" title="Bold (Ctrl/Cmd+B)" onMouseDown={tb("bold")}><b>B</b></button>
        <button className="rt-btn" title="Italic (Ctrl/Cmd+I)" onMouseDown={tb("italic")}><i>I</i></button>
        <button className="rt-btn" title="Strikethrough" onMouseDown={tb("strikeThrough")}><s>S</s></button>
        <button className="rt-btn" title="Inline code" onMouseDown={(e) => { e.preventDefault(); inlineCode(); }}>{"</>"}</button>
        <button className="rt-btn" title="Clear formatting" onMouseDown={tb("removeFormat")}>T̶</button>
        <span className="rt-sep" />
        <button className="rt-btn" title="Bulleted list" onMouseDown={tb("insertUnorderedList")}>• List</button>
        <button className="rt-btn" title="Numbered list" onMouseDown={tb("insertOrderedList")}>1. List</button>
        <button className="rt-btn" title="Link (Ctrl/Cmd+K)" onMouseDown={(e) => { e.preventDefault(); link(); }}>🔗</button>
        <button className="rt-btn" title="Remove link" onMouseDown={tb("unlink")}>⛓︎̸</button>
        <button className="rt-btn" title="Insert image" onMouseDown={(e) => { e.preventDefault(); image(); }}>🖼</button>
        <button className="rt-btn" title="Divider" onMouseDown={tb("insertHorizontalRule")}>―</button>
        <span className="rt-sep" />
        <button className="rt-btn" title="Undo (Ctrl/Cmd+Z)" onMouseDown={tb("undo")}>↶</button>
        <button className="rt-btn" title="Redo (Ctrl/Cmd+Shift+Z)" onMouseDown={tb("redo")}>↷</button>
      </div>
      <div
        ref={ref}
        className="rt-editor md"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={handleInput}
        onBlur={handleInput}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
