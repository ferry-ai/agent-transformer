/*
 * Runs inside the chat page: returns the last message rendered as Markdown, plus the
 * reasoning shown above it, if any. It is read as text and handed to Playwright, so it
 * must stay one function expression with no imports.
 */
(opts) => {
  const messages = document.querySelectorAll(opts.message);
  const last = messages[messages.length - 1];
  if (!last) return { text: '', thinking: '', html: '', messages: 0 };

  // Nested Markdown blocks belong to their parent: keep only the outermost ones.
  const all = Array.from(last.querySelectorAll(opts.markdown));
  const blocks = all.filter((block) => !all.some((other) => other !== block && other.contains(block)));
  const text = blocks.length > 0 ? render(blocks[blocks.length - 1]) : tidy(last.innerText || '');
  const thinking = blocks.slice(0, -1).map(render).join('\n\n');
  return { text: text, thinking: thinking, html: last.outerHTML, messages: messages.length };

  function render(element) {
    return tidy(children(element, 0));
  }

  function tidy(value) {
    return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function children(element, depth) {
    let out = '';
    element.childNodes.forEach((child) => {
      out += convert(child, depth);
    });
    return out;
  }

  // Copy and download buttons, icons and code-block banners are not part of the answer.
  function ignored(element) {
    const tag = element.tagName.toLowerCase();
    const cls = typeof element.className === 'string' ? element.className : '';
    return (
      tag === 'button' ||
      tag === 'svg' ||
      tag === 'style' ||
      tag === 'script' ||
      element.getAttribute('role') === 'button' ||
      element.getAttribute('aria-hidden') === 'true' ||
      /banner|infostring/.test(cls)
    );
  }

  function language(pre) {
    const code = pre.querySelector('code[class*="language-"]');
    const match = code && code.className.match(/language-([\w+#.-]+)/);
    if (match) return match[1];
    let node = pre.parentElement;
    for (let level = 0; node && level < 3; level += 1, node = node.parentElement) {
      const label = node.querySelector('[class*="infostring"], [class*="lang"]');
      if (label && !pre.contains(label) && !label.contains(pre)) {
        const name = (label.textContent || '').trim();
        if (name && name.length <= 30 && !/\s/.test(name)) return name;
      }
    }
    return '';
  }

  function convert(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node;
    if (element.classList.contains('katex')) {
      const tex = element.querySelector('annotation[encoding="application/x-tex"]');
      return tex ? '$' + tex.textContent + '$' : element.textContent || '';
    }
    if (ignored(element)) return '';
    const tag = element.tagName.toLowerCase();
    switch (tag) {
      case 'pre':
        return '\n\n```' + language(element) + '\n' + element.innerText.replace(/\n+$/, '') + '\n```\n\n';
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'p':
        return '\n\n' + children(element, depth).trim() + '\n\n';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children(element, depth).trim() + '\n\n';
      case 'strong':
      case 'b':
        return '**' + children(element, depth) + '**';
      case 'em':
      case 'i':
        return '*' + children(element, depth) + '*';
      case 'code':
        return '`' + (element.textContent || '') + '`';
      case 'a':
        return '[' + children(element, depth) + '](' + (element.getAttribute('href') || '') + ')';
      case 'ul':
      case 'ol':
        return '\n' + list(element, tag === 'ol', depth) + '\n';
      case 'blockquote':
        return '\n\n' + children(element, depth).trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
      case 'table':
        return '\n\n' + table(element) + '\n\n';
      case 'div':
      case 'section':
        return '\n' + children(element, depth) + '\n';
      default:
        return children(element, depth);
    }
  }

  function list(element, ordered, depth) {
    const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
    return items
      .map((item, index) => '  '.repeat(depth) + (ordered ? index + 1 + '. ' : '- ') + children(item, depth + 1).trim())
      .join('\n');
  }

  function table(element) {
    const rows = Array.from(element.querySelectorAll('tr')).map((row) =>
      Array.from(row.children).map((cell) => (cell.textContent || '').trim().replace(/\|/g, '\\|')),
    );
    if (rows.length === 0) return '';
    const lines = ['| ' + rows[0].join(' | ') + ' |', '|' + rows[0].map(() => ' --- ').join('|') + '|'];
    rows.slice(1).forEach((row) => lines.push('| ' + row.join(' | ') + ' |'));
    return lines.join('\n');
  }
}
