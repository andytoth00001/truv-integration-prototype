/**
 * FILE SUMMARY: Tiny CSV parser + serializer for the Coverage Analysis app.
 *
 * Handles the subset of RFC 4180 we actually need: comma delimiter, optional
 * double-quoted fields with embedded commas / quotes / newlines. No streaming —
 * Coverage Analysis caps uploads at 10K rows so the whole file fits in memory.
 */

// Parse a CSV string into an array of objects keyed by the first row's headers.
// If `headerRow` looks like data (no field equal to "name" case-insensitively),
// we synthesize headers as col_0, col_1, ... so callers can still index by position.
export function parseCsv(text) {
  const rows = parseRows(text);
  if (!rows.length) return { headers: [], rows: [] };

  const first = rows[0].map(c => String(c).trim());
  const looksLikeHeader = first.some(c => c.toLowerCase() === 'name');

  const headers = looksLikeHeader
    ? first.map(h => h.toLowerCase())
    : first.map((_, i) => `col_${i}`);
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  const objects = dataRows
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] ?? '').toString().trim(); });
      return obj;
    });

  return { headers, rows: objects };
}

// Low-level: splits text into a 2D array of cells, handling quoted fields.
function parseRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Serialize an array of objects to a CSV string. Headers come from the
// caller-supplied list (preserves column order); falls back to keys of the first row.
// `headerLabels` optionally maps a column key to a display label used in the header row
// (e.g. { status: 'Search Status' }); columns without an entry use the raw key.
export function serializeCsv(rows, headers, headerLabels) {
  const cols = headers || (rows[0] ? Object.keys(rows[0]) : []);
  const escape = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const labels = cols.map(c => (headerLabels && headerLabels[c]) || c);
  const lines = [labels.map(escape).join(',')];
  for (const row of rows) lines.push(cols.map(c => escape(row[c])).join(','));
  return lines.join('\n') + '\n';
}
