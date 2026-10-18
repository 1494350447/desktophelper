export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmphasis(escaped: string): string {
  let value = escaped;
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  value = value.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);
  value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  value = value.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?;:])/g, "$1<em>$2</em>");
  value = value.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?;:])/g, "$1<em>$2</em>");
  return value;
}

export function renderInline(raw: string): string {
  const parts = raw.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      const escaped = escapeHtml(part).replace(/\n/g, "<br>");
      return renderEmphasis(escaped);
    })
    .join("");
}

export function renderMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  let index = 0;
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };
  const openList = (type: "ul" | "ol") => {
    if (listType === type) return;
    closeList();
    output.push(`<${type}>`);
    listType = type;
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```([a-zA-Z0-9_+-]*)\s*$/);
    if (fence) {
      closeParagraph();
      closeList();
      const language = fence[1] || "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      output.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeList();
      index += 1;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeParagraph();
      closeList();
      output.push("<hr>");
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      closeParagraph();
      openList("ul");
      output.push(`<li>${renderInline(unordered[1])}</li>`);
      index += 1;
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      closeParagraph();
      openList("ol");
      output.push(`<li>${renderInline(ordered[1])}</li>`);
      index += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeParagraph();
      closeList();
      const quoteLines: string[] = [quote[1]];
      index += 1;
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  closeParagraph();
  closeList();
  return output.join("\n");
}