/**
 * Purpose-built XML reader for DBGp packets.
 *
 * DBGp responses are small, well-formed, single documents: elements with
 * attributes, text nodes (often base64, flagged by an `encoding` attribute),
 * self-closing tags. No namespaces to resolve, no mixed-content semantics to
 * preserve. A full XML dependency would be overkill; a regex would be wrong.
 * This tokenizer builds an element tree and nothing more.
 *
 * @module dsh-debug/lib/xml
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

function unescape(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10))
    return ENTITIES[entity] ?? whole
  })
}

function parseAttributes(source) {
  const attrs = {}
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(source)) !== null) {
    attrs[match[1]] = unescape(match[3] ?? match[4] ?? '')
  }
  return attrs
}

/**
 * Parse one XML document into `{ name, attrs, children, text }`.
 * `children` contains elements only; `text` is the concatenation of text
 * nodes (entity-decoded). Comments, PIs and the prolog are skipped.
 * @param {string} input
 */
export function parseXml(input) {
  let i = 0
  const src = input

  function error(message) {
    return new Error(`XML parse error at ${i}: ${message} — near ${JSON.stringify(src.slice(i, i + 60))}`)
  }

  function parseElement() {
    if (src[i] !== '<') throw error('expected element')
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end === -1) throw error('unterminated comment')
      i = end + 3
      return parseElement()
    }
    if (src.startsWith('<![CDATA[', i)) throw error('CDATA is not an element')
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2)
      if (end === -1) throw error('unterminated PI')
      i = end + 2
      return parseElement()
    }
    if (src.startsWith('<!', i)) { // DOCTYPE and friends — skip to '>'
      const end = src.indexOf('>', i + 2)
      if (end === -1) throw error('unterminated declaration')
      i = end + 1
      return parseElement()
    }

    const openEnd = src.indexOf('>', i)
    if (openEnd === -1) throw error('unterminated tag')
    const openTag = src.slice(i + 1, openEnd)
    const selfClosing = openTag.endsWith('/')
    const nameMatch = /^([\w:.-]+)/.exec(openTag)
    if (!nameMatch) throw error('missing element name')
    const name = nameMatch[1]
    const attrs = parseAttributes(openTag.slice(name.length))
    const element = { name, attrs, children: [], text: '' }
    i = openEnd + 1
    if (selfClosing) return element

    for (;;) {
      if (i >= src.length) throw error(`unterminated <${name}>`)
      if (src.startsWith(`</${name}`, i)) {
        const closeEnd = src.indexOf('>', i)
        if (closeEnd === -1) throw error('unterminated close tag')
        i = closeEnd + 1
        return element
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i + 9)
        if (end === -1) throw error('unterminated CDATA')
        element.text += src.slice(i + 9, end)
        i = end + 3
        continue
      }
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4)
        if (end === -1) throw error('unterminated comment')
        i = end + 3
        continue
      }
      if (src[i] === '<') {
        element.children.push(parseElement())
        continue
      }
      const textEnd = src.indexOf('<', i)
      element.text += unescape(src.slice(i, textEnd === -1 ? src.length : textEnd))
      i = textEnd === -1 ? src.length : textEnd
    }
  }

  // Skip the prolog / whitespace before the root element.
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2)
      if (end === -1) throw error('unterminated prolog')
      i = end + 2
      continue
    }
    break
  }
  const root = parseElement()
  return root
}
