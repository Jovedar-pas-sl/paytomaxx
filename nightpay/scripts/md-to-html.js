#!/usr/bin/env node
/**
 * Convertidor MD → HTML mínimo pero suficiente para el doc del proyecto.
 * Cubre: headers, listas, tablas, code blocks, blockquotes, inline code,
 * bold, italic, links, hr.
 *
 * Uso: node scripts/md-to-html.js <input.md> <output.html>
 */
const fs = require('fs');

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s) {
  // Inline code primero (no procesar bold dentro)
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  // Bold + italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

function convertTable(lines) {
  // lines: ["| a | b |", "|---|---|", "| 1 | 2 |", ...]
  const header = lines[0].slice(1, -1).split('|').map((c) => c.trim());
  const body = lines.slice(2).map((row) =>
    row.slice(1, -1).split('|').map((c) => c.trim()),
  );
  let html = '<table>\n<thead><tr>';
  header.forEach((h) => (html += `<th>${inline(h)}</th>`));
  html += '</tr></thead>\n<tbody>';
  body.forEach((row) => {
    html += '<tr>';
    row.forEach((c) => (html += `<td>${inline(c)}</td>`));
    html += '</tr>\n';
  });
  html += '</tbody></table>';
  return html;
}

function convert(md) {
  const lines = md.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Code block ``` ... ```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const langClass = lang ? ` class="lang-${lang}"` : '';
      html += `<pre><code${langClass}>${escapeHtml(buf.join('\n'))}</code></pre>\n`;
      continue;
    }

    // Tables — heuristic: line starts with |, next line has |--- pattern
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      html += convertTable(tableLines) + '\n';
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = inline(headerMatch[2]);
      html += `<h${level}>${content}</h${level}>\n`;
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      html += '<hr>\n';
      i++;
      continue;
    }

    // Blockquote (multi-line)
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      // Recurse on the inner content for nested formatting
      const inner = convert(buf.join('\n'));
      html += `<blockquote>${inner}</blockquote>\n`;
      continue;
    }

    // Unordered list (could be multiple items)
    if (/^[*\-]\s+/.test(line)) {
      html += '<ul>\n';
      while (i < lines.length && /^[*\-]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^[*\-]\s+/, '');
        html += `<li>${inline(content)}</li>\n`;
        i++;
      }
      html += '</ul>\n';
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      html += '<ol>\n';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\d+\.\s+/, '');
        html += `<li>${inline(content)}</li>\n`;
        i++;
      }
      html += '</ol>\n';
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-empty non-special lines)
    const paraBuf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !lines[i].startsWith('|') &&
      !/^[*\-]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paraBuf.push(lines[i]);
      i++;
    }
    html += `<p>${inline(paraBuf.join(' '))}</p>\n`;
  }
  return html;
}

const TEMPLATE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>NightPay — Estado del proyecto</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  :root {
    --ink: #111827; --muted: #6b7280; --border: #e5e7eb;
    --accent: #2563eb; --bg-soft: #f9fafb; --code-bg: #f3f4f6;
    --quote-bg: #fef9e7;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: var(--ink); line-height: 1.55; font-size: 10.5pt;
  }
  body { padding: 0 16px; max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 22pt; font-weight: 700; margin: 18px 0 10px;
       border-bottom: 3px solid var(--accent); padding-bottom: 8px; page-break-after: avoid; }
  h2 { font-size: 15pt; margin: 28px 0 10px; padding-bottom: 4px;
       border-bottom: 1px solid var(--border); color: var(--accent); page-break-after: avoid;
       page-break-before: auto; }
  h3 { font-size: 12.5pt; margin: 18px 0 6px; page-break-after: avoid; }
  h4 { font-size: 11pt; margin: 12px 0 4px; color: var(--muted); page-break-after: avoid; }
  p { margin: 6px 0 10px; text-align: justify; }
  ul, ol { margin: 6px 0 12px; padding-left: 24px; }
  li { margin: 3px 0; }
  hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
  blockquote { border-left: 3px solid #f59e0b; padding: 8px 14px; margin: 12px 0;
               background: var(--quote-bg); color: #78350f; border-radius: 0 4px 4px 0; }
  blockquote p { color: #78350f; }
  blockquote code { background: rgba(0,0,0,0.06); }
  table { border-collapse: collapse; width: 100%; margin: 12px 0;
          font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: var(--bg-soft); font-weight: 600; color: var(--ink); }
  tr:nth-child(even) td { background: #fcfcfd; }
  code { font-family: 'Cascadia Code', Consolas, monospace; background: var(--code-bg);
         padding: 1px 5px; border-radius: 3px; font-size: 9.5pt; }
  pre { background: #1f2937; color: #f3f4f6; padding: 12px 16px; border-radius: 6px;
        overflow-x: auto; font-size: 8.5pt; line-height: 1.5;
        page-break-inside: avoid; }
  pre code { background: none; padding: 0; color: inherit; }
  strong { font-weight: 600; }
  em { font-style: italic; }
  a { color: var(--accent); text-decoration: none; }
  @media print {
    body { padding: 0; }
    h2 { page-break-before: auto; }
    table, pre, blockquote { break-inside: avoid; }
  }
  .doc-footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--border);
                color: var(--muted); font-size: 8.5pt; text-align: center; }
</style>
</head>
<body>
__CONTENT__
<div class="doc-footer">NightPay · v2 con ejemplos · Mayo 2026</div>
</body>
</html>`;

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node md-to-html.js <input.md> <output.html>');
    process.exit(1);
  }
  const md = fs.readFileSync(inputPath, 'utf8');
  const inner = convert(md);
  const html = TEMPLATE.replace('__CONTENT__', inner);
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`✓ ${outputPath} (${html.length} bytes)`);
}

main();
