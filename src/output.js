import { styleText } from 'node:util';

export const EXIT_CODES = {
  OK: 0,
  ERROR: 1,
  CONFIRMATION_REQUIRED: 2,
  AUTH_REQUIRED: 3,
  NOT_FOUND: 4,
  BROWSER_ERROR: 5
};

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function c(style, text) {
  if (!useColor()) return String(text);
  try {
    return styleText(style, String(text));
  } catch {
    return String(text);
  }
}

export function printJson(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

export function printError(message, { json = false, code = 'ERROR', details = null, exitCode = EXIT_CODES.ERROR } = {}) {
  if (json) {
    printJson({ ok: false, code, error: message, ...(details ? { details } : {}) });
  } else {
    process.stderr.write(`${c('red', '✗ Hata:')} ${message}\n`);
    if (details?.hint) {
      process.stderr.write(`${c('yellow', '  İpucu:')} ${details.hint}\n`);
    }
  }
  process.exitCode = exitCode;
}

export function printTable(headers, rows) {
  if (!rows.length) {
    process.stdout.write(c('gray', '(kayıt yok)\n'));
    return;
  }
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => stripAnsi(String(r[i] ?? '')).length))
  );

  const line = (cols, isHeader = false) =>
    cols
      .map((col, i) => {
        const s = String(col ?? '');
        const pad = ' '.repeat(Math.max(0, widths[i] - stripAnsi(s).length));
        return isHeader ? c('bold', s) + pad : s + pad;
      })
      .join('  ');

  process.stdout.write(line(headers, true) + '\n');
  process.stdout.write(c('gray', widths.map((w) => '─'.repeat(w)).join('  ')) + '\n');
  for (const row of rows) {
    process.stdout.write(line(row) + '\n');
  }
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export function truncate(str, max = 48) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
