/*
 * Local, no-network PDF text extraction for common selectable-text timetables.
 * This is intentionally conservative, not a replacement for Mozilla PDF.js.
 * Unsupported/image-only files fail visibly instead of inventing lessons.
 */
const MAX_BYTES = 10_000_000;
function binary(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16384) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  }
  return chunks.join('');
}
function bytesOf(text) { return Uint8Array.from(text, c => c.charCodeAt(0) & 255); }
function ascii85(text) {
  let s = text.replace(/^\s*<~/, '').replace(/~>\s*$/, '').replace(/\s/g, '');
  const out = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    const chunk = s.slice(i, i + 5); i += chunk.length;
    if (chunk.length === 1) break;
    const padded = chunk.padEnd(5, 'u');
    let val = 0;
    for (const c of padded) val = val * 85 + (c.charCodeAt(0) - 33);
    if (val > 0xffffffff || val < 0) throw new Error('The PDF has an invalid compressed text stream.');
    const group = [(val >>> 24) & 255, (val >>> 16) & 255, (val >>> 8) & 255, val & 255];
    out.push(...group.slice(0, chunk.length - 1));
  }
  return new Uint8Array(out);
}
async function inflate(data) {
  if (!globalThis.DecompressionStream) throw new Error('Your browser does not support local PDF decompression. Paste the timetable text instead.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function parseCmap(text) {
  const map = new Map();
  for (const block of text.matchAll(/\b\d+\s+beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of block[1].matchAll(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>/g)) map.set(match[1].toUpperCase(), unicodeHex(match[2]));
  }
  for (const block of text.matchAll(/\b\d+\s+beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const match of block[1].matchAll(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>\s*<([\da-fA-F]+)>/g)) {
      const start = parseInt(match[1], 16), end = parseInt(match[2], 16), base = parseInt(match[3], 16);
      if (end - start > 500) continue;
      for (let n = start; n <= end; n++) map.set(n.toString(16).toUpperCase().padStart(match[1].length, '0'), String.fromCodePoint(base + n - start));
    }
  }
  return map;
}
function unicodeHex(hex) {
  const b = new Uint8Array((hex.match(/../g) || []).map(x => parseInt(x, 16)));
  if (b.length % 2 === 0 && b.length) return new TextDecoder('utf-16be').decode(b);
  return binary(b);
}
function tokenize(text) {
  const result = [];
  const re = /\s+|%[^\r\n]*|\((?:\\[\s\S]|[^\\)])*\)|<(?!!|<)[\da-fA-F\s]*>|\/[^\s\[\]<>/()]+|\[|\]|[^\s\[\]<>/()%]+/gy;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) { at++; continue; }
    at = re.lastIndex;
    if (!/^\s|^%/.test(m[0])) result.push(m[0]);
  }
  return result;
}
function pdfLiteral(value) {
  const raw = value.slice(1, -1);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const c = raw[++i];
    if (c == null) break;
    if (/[0-7]/.test(c)) {
      let oct = c;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || 'x')) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (c === 'n') out += '\n';
    else if (c === 'r') out += '\r';
    else if (c === 't') out += '\t';
    else if (c === '\n') { /* PDF escaped line break */ }
    else if (c === '\r') { if (raw[i+1] === '\n') i++; }
    else out += c;
  }
  return out;
}
function decodeGlyphs(bytes, map) {
  // mPDF (the format used by VILNIUS TECH) writes most ordinary glyphs as
  // UTF-16BE without a BOM. Treating those bytes as Windows-1252 inserts NULs
  // between every character and makes a perfectly selectable PDF unparseable.
  if (bytes.length >= 4 && bytes.length % 2 === 0) {
    let zeroHigh = 0, zeroLow = 0, pairs = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      pairs++; if (bytes[i] === 0) zeroHigh++; if (bytes[i+1] === 0) zeroLow++;
    }
    if (pairs > 1 && zeroHigh / pairs >= 0.55 && zeroLow / pairs < 0.25) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
  }
  if (map?.size) {
    let out = '', hit = 0;
    const width = [...map.keys()].some(k => k.length >= 4) ? 2 : 1;
    for (let i = 0; i < bytes.length; i += width) {
      const key = [...bytes.slice(i, i+width)].map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      if (map.has(key)) { out += map.get(key); hit++; }
      else out += String.fromCharCode(...bytes.slice(i, i+width));
    }
    if (hit > 0) return out;
  }
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes.slice(2));
  return new TextDecoder('windows-1252').decode(bytes);
}
function readText(stream, fontMaps) {
  const lines = [];
  let line = '', stack = [], font = '';
  const flush = () => { const clean = line.replace(/\s+/g, ' ').trim(); if (clean) lines.push(clean); line = ''; };
  const decode = raw => {
    if (raw.startsWith('(')) return decodeGlyphs(bytesOf(pdfLiteral(raw)), fontMaps.get(font));
    if (/^<[\da-fA-F\s]+>$/.test(raw)) return decodeGlyphs(new Uint8Array((raw.slice(1,-1).replace(/\s/g,'').match(/../g)||[]).map(x=>parseInt(x,16))), fontMaps.get(font));
    return '';
  };
  const tokens = tokenize(stream);
  for (let i=0; i<tokens.length; i++) {
    const tok = tokens[i];
    if (tok === 'BT' || tok === 'ET') { flush(); stack=[]; continue; }
    if (tok === 'Tf') { font = String(stack.at(-2) || font).replace(/^\//,''); stack=[]; continue; }
    if (tok === 'Tj' || tok === "'" || tok === '"') {
      if (tok !== 'Tj') flush();
      const part = decode(stack.at(-1) || '');
      line += (line && part && !/\s$/.test(line) ? ' ' : '') + part;
      stack=[]; continue;
    }
    if (tok === 'TJ') {
      const chars = stack.filter(s=>s.startsWith('(') || /^<[\da-fA-F\s]+>$/.test(s)).map(decode).join('');
      line += (line && chars ? ' ' : '') + chars; stack=[]; continue;
    }
    if (tok === 'Td' || tok === 'TD' || tok === 'Tm' || tok === 'T*') { flush(); stack=[]; continue; }
    if (/^(?:Tc|Tw|Tz|TL|Ts|Tr|q|Q|cm|re|m|l|S|f|W|n|rg|RG|g|G|w|d|Do|gs)$/.test(tok)) { stack=[]; continue; }
    stack.push(tok);
    if (stack.length > 1000) stack = stack.slice(-100);
  }
  flush();
  return lines;
}
export async function extractPdfText(file) {
  if (!file || file.size > MAX_BYTES) throw new Error('Choose a PDF smaller than 10 MB.');
  const buffer = new Uint8Array(await file.arrayBuffer());
  const raw = binary(buffer);
  if (!raw.startsWith('%PDF-')) throw new Error('This is not a valid PDF file.');
  const objects = new Map();
  for (const m of raw.matchAll(/(?:^|\s)(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g)) objects.set(m[1], m[3]);
  const decoded = new Map();
  for (const [id, obj] of objects) {
    const match = obj.match(/stream\r?\n([\s\S]*?)endstream/);
    if (!match) continue;
    const dict = obj.slice(0, match.index);
    if (/\/Subtype\s*\/Image\b/.test(dict)) continue;
    let bytes = bytesOf(match[1]);
    // PDF stream /Length excludes the CR/LF preceding `endstream`. Node's
    // inflater tolerates trailing bytes; Chromium's DecompressionStream does
    // not and rejects the entire (otherwise selectable-text) PDF.
    const lengthMatch = dict.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/);
    if (lengthMatch && bytes.length >= Number(lengthMatch[1])) bytes = bytes.slice(0, Number(lengthMatch[1]));
    try {
      const filters = dict.match(/\/Filter\s*(\[[^\]]+\]|\/\w+)/)?.[1] || '';
      if (/\/ASCII85Decode/.test(filters)) bytes = ascii85(binary(bytes));
      if (/\/FlateDecode/.test(filters)) bytes = await inflate(bytes);
      if (/\/LZWDecode|\/DCTDecode|\/JPXDecode/.test(filters)) continue;
      if (bytes.length > 2_000_000) continue;
      decoded.set(id, binary(bytes));
    } catch { /* Unsupported individual stream; do not corrupt others. */ }
  }
  const fontMaps = new Map();
  for (const obj of objects.values()) {
    for (const m of obj.matchAll(/\/(F[\w\d]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fontObj = objects.get(m[2]);
      const cmapId = fontObj?.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)?.[1];
      if (cmapId && decoded.has(cmapId)) fontMaps.set(m[1], parseCmap(decoded.get(cmapId)));
    }
  }
  const all = [];
  for (const stream of decoded.values()) if (/\bBT\b/.test(stream)) all.push(...readText(stream, fontMaps));
  const text = all.join('\n').replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000e-\u001f]/g, ' ').trim();
  if (!text || text.length < 12) throw new Error('No selectable timetable text found. For scanned/image-based PDFs, paste copied text or add classes manually.');
  return text;
}
