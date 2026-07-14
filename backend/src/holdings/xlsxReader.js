// ── Minimal XLSX reader — zero dependencies ──────────────────────────────────
//
// An .xlsx file is a ZIP archive of XML parts. We need exactly two of them:
//   xl/sharedStrings.xml  — the string table (cells reference strings by index)
//   xl/worksheets/sheet1.xml — the cell grid
//
// Rather than pull in SheetJS (a large dependency with a history of CVEs) to read
// two XML files, this walks the ZIP central directory and inflates the two entries
// with Node's built-in zlib. It is deliberately NOT a general xlsx library: it
// reads a single sheet of cell values and nothing else. No formulas are evaluated,
// no macros, no external references — which is also the safe choice for a file
// arriving over an HTTP upload.

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;   // End of Central Directory
const CEN_SIG  = 0x02014b50;   // Central directory file header
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;  // inflate bomb guard (40 MB per part)

/**
 * Locate the End-of-Central-Directory record and walk the central directory,
 * returning { name -> Buffer } for the entries we care about.
 *
 * @param {Buffer} buf
 * @param {(name: string) => boolean} want
 */
function unzip(buf, want) {
  // EOCD lives in the last 64KB, after a variable-length comment.
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid XLSX file (no ZIP end-of-directory record found).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);   // offset of first central-directory header

  const out = {};

  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;

    const method     = buf.readUInt16LE(p + 10);
    const compSize   = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen    = buf.readUInt16LE(p + 28);
    const extraLen   = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff   = buf.readUInt32LE(p + 42);
    const name       = buf.toString('utf8', p + 46, p + 46 + nameLen);

    p += 46 + nameLen + extraLen + commentLen;

    if (!want(name)) continue;
    if (uncompSize > MAX_ENTRY_BYTES) {
      throw new Error(`XLSX entry "${name}" is implausibly large (${uncompSize} bytes) — refusing to inflate.`);
    }

    // Jump to the local file header to find where the data actually begins;
    // its name/extra lengths can differ from the central directory's.
    const lnameLen  = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0)      out[name] = Buffer.from(raw);              // stored
    else if (method === 8) out[name] = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    else throw new Error(`XLSX entry "${name}" uses unsupported compression method ${method}.`);
  }

  return out;
}

// XML entity decoding. Zerodha sector names contain "&amp;"
// ("ENGINEERING &amp; CAPITAL GOODS"), so skipping this mangles real data.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g,  '&');   // last, so "&amp;lt;" does not become "<"
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    // A <si> may hold several <t> runs (rich text); concatenate them.
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map(t => decodeEntities(t[1]))
      .join('')
  );
}

// 'BC' -> 54 (1-based). Cell refs are like "AB23".
function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read the first worksheet as a dense array of string rows.
 * Missing cells become '' so column indexes stay aligned — a sparse row would
 * otherwise shift every value left and silently map data to the wrong column.
 *
 * @param {Buffer} buffer  raw .xlsx bytes
 * @returns {string[][]}
 */
function readXlsx(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('readXlsx expects a Buffer.');

  const parts = unzip(buffer, (n) =>
    n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet1\.xml$/.test(n)
  );

  const sheetXml = parts['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('XLSX contains no readable worksheet (xl/worksheets/sheet1.xml missing).');

  const strings = parseSharedStrings(parts['xl/sharedStrings.xml']?.toString('utf8'));
  const xml     = sheetXml.toString('utf8');

  const rows = [];
  for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cM of rowM[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const idx   = colToIndex(cM[1]);
      const attrs = cM[2] || '';
      const body  = cM[3] || '';

      let value = '';
      if (/t="s"/.test(attrs)) {
        // Shared-string reference
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        if (v) value = strings[Number(v[1])] ?? '';
      } else if (/t="inlineStr"/.test(attrs)) {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeEntities(t[1])).join('');
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        if (v) value = decodeEntities(v[1]);
      }

      while (cells.length < idx) cells.push('');   // keep columns aligned
      cells[idx] = value;
    }
    rows.push(cells);
  }

  return rows;
}

module.exports = { readXlsx, decodeEntities };
