/**
 * Minimal Markdown to DOM renderer.
 *
 * Builds Nodes directly via document.createElement (no innerHTML, no
 * HTML-string parsing — safe against XSS in LLM output). Covers the
 * subset that matters for Q and A responses:
 *
 *   # headings (h1-h6)
 *   paragraphs (blank-line separated)
 *   - / * unordered lists
 *   1. ordered lists
 *   > blockquotes
 *   ```fenced``` code blocks
 *   `inline` code, **bold**, *italic*, [text](url)
 *   horizontal rule (---)
 *   GFM pipe tables (| a | b | with a |---|---| delimiter row)
 *
 * Anything not matched falls through as plain text.
 */

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const blocks = splitBlocks(text);
  for (const block of blocks) renderBlock(block, frag);
  return frag;
}

interface Block {
  kind: "code" | "heading" | "list" | "blockquote" | "hr" | "paragraph" | "table";
  lines: string[];
  level?: number;
  ordered?: boolean;
  lang?: string;
}

/** A GFM table delimiter row: only `| - : space`, at least one `-`, and
 *  every cell shaped like `:?-+:?` (optional alignment colons). */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !/^[\s|:-]+$/.test(t)) return false;
  const cells = splitRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Split a table row into trimmed cells, dropping the optional leading and
 *  trailing pipes and honouring escaped pipes (`\|`). */
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

/** Map a delimiter cell to a CSS text-align value ("" = default). */
function cellAlign(delimCell: string): "" | "left" | "center" | "right" {
  const c = delimCell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "";
}

function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", lines: codeLines, lang });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", lines: [heading[2]], level: heading[1].length });
      i++;
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr", lines: [] });
      i++;
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const listLines: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "list", lines: listLines, ordered });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }

    // GFM table: a row containing `|` immediately followed by a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const tableLines: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "table", lines: tableLines });
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^(-{3,}|_{3,}|\*{3,})\s*$/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", lines: paraLines });
  }
  return blocks;
}

function renderBlock(block: Block, target: Node): void {
  switch (block.kind) {
    case "code": {
      const pre = document.createElement("pre");
      pre.className = "md-code";
      if (block.lang) pre.dataset.lang = block.lang;
      const code = document.createElement("code");
      code.textContent = block.lines.join("\n");
      pre.append(code);
      target.appendChild(pre);
      return;
    }
    case "heading": {
      const level = Math.max(1, Math.min(6, block.level ?? 1));
      const h = document.createElement(`h${level}`);
      h.className = "md-h";
      appendInline(h, block.lines[0]);
      target.appendChild(h);
      return;
    }
    case "hr": {
      target.appendChild(document.createElement("hr"));
      return;
    }
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      list.className = "md-list";
      for (const raw of block.lines) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(raw);
        const item = document.createElement("li");
        appendInline(item, m ? m[2] : raw);
        list.appendChild(item);
      }
      target.appendChild(list);
      return;
    }
    case "blockquote": {
      const bq = document.createElement("blockquote");
      bq.className = "md-quote";
      appendInline(bq, block.lines.join(" "));
      target.appendChild(bq);
      return;
    }
    case "table": {
      const [headerLine, delimLine, ...bodyLines] = block.lines;
      const aligns = splitRow(delimLine).map(cellAlign);
      const table = document.createElement("table");
      table.className = "md-table";

      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      splitRow(headerLine).forEach((cell, idx) => {
        const th = document.createElement("th");
        if (aligns[idx]) th.style.textAlign = aligns[idx];
        appendInline(th, cell);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const row of bodyLines) {
        if (!row.trim()) continue;
        const tr = document.createElement("tr");
        splitRow(row).forEach((cell, idx) => {
          const td = document.createElement("td");
          if (aligns[idx]) td.style.textAlign = aligns[idx];
          appendInline(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      target.appendChild(table);
      return;
    }
    case "paragraph": {
      const p = document.createElement("p");
      p.className = "md-p";
      appendInline(p, block.lines.join(" "));
      target.appendChild(p);
      return;
    }
  }
}

function appendInline(parent: Node, text: string): void {
  for (const node of parseInline(text)) parent.appendChild(node);
}

/** Single left-to-right inline scan. Code spans are atomic (their
 *  contents are never re-parsed), but links and emphasis may wrap a
 *  code span — so `**`x`**` renders as bold containing code. A split
 *  pipeline can't do both: code-first severs the `**` around a code
 *  span; code-last lets `*` inside a code span be parsed as italic. */
function parseInline(text: string): Node[] {
  const nodes: Node[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) {
      nodes.push(document.createTextNode(buf));
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      const el = document.createElement("code");
      el.className = "md-inline-code";
      el.textContent = code[1];
      nodes.push(el);
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      const a = document.createElement("a");
      a.href = link[2];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "md-link";
      for (const n of parseInline(link[1])) a.appendChild(n);
      nodes.push(a);
      i += link[0].length;
      continue;
    }

    // Bold before italic so `**` wins over a single `*`.
    const emphasis =
      matchEmphasis(rest, "**") ?? matchEmphasis(rest, "*") ?? matchEmphasis(rest, "_");
    if (emphasis) {
      flush();
      const el = document.createElement(emphasis.delim === "**" ? "strong" : "em");
      for (const n of parseInline(emphasis.inner)) el.appendChild(n);
      nodes.push(el);
      i += emphasis.length;
      continue;
    }

    buf += text[i];
    i++;
  }
  flush();
  return nodes;
}

/** Match `delim ... delim` at the start of `text`. Skips over code
 *  spans while scanning for the closing delimiter, so emphasis can
 *  wrap a code span whose contents contain the delimiter character. */
function matchEmphasis(
  text: string,
  delim: "**" | "*" | "_",
): { delim: "**" | "*" | "_"; inner: string; length: number } | null {
  if (!text.startsWith(delim)) return null;
  const dl = delim.length;
  let j = dl;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\n") return null; // emphasis doesn't span lines
    if (ch === "`") {
      const close = text.indexOf("`", j + 1);
      if (close === -1) {
        j++;
        continue;
      }
      j = close + 1;
      continue;
    }
    if (text.startsWith(delim, j)) {
      const inner = text.slice(dl, j);
      return inner ? { delim, inner, length: j + dl } : null;
    }
    j++;
  }
  return null;
}
