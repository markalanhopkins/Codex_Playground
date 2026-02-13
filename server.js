const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.ico': 'image/x-icon'
};

function pctChange(base, current) {
  if (typeof base !== 'number' || Number.isNaN(base) || base === 0) return null;
  return ((current - base) / base) * 100;
}

function previousMonthSameDay(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const prevMonthDate = new Date(Date.UTC(year, month, 1));
  prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1);

  const prevYear = prevMonthDate.getUTCFullYear();
  const prevMonth = prevMonthDate.getUTCMonth();
  const daysInPrevMonth = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();
  const adjustedDay = Math.min(day, daysInPrevMonth);

  return new Date(Date.UTC(prevYear, prevMonth, adjustedDay));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (cols[index] || '').trim();
    });
    return row;
  });
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(raw) {
  const symbol = raw.trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(symbol)) {
    throw new Error('Invalid symbol format');
  }

  return symbol.includes('.') ? symbol : `${symbol}.US`;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', url], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || 'Failed to fetch upstream data'));
        return;
      }
      resolve(stdout);
    });
  });
}

function findRowForTargetDate(rows, targetDate) {
  const targetIso = targetDate.toISOString().slice(0, 10);

  let before = null;
  for (const row of rows) {
    if (row.Date === targetIso) {
      return row;
    }

    if (row.Date > targetIso) {
      return row;
    }

    before = row;
  }

  return before;
}

async function getStockMetrics(symbol) {
  const marketSymbol = normalizeSymbol(symbol);
  const quoteUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(marketSymbol.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
  const historyUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(marketSymbol.toLowerCase())}&i=d`;

  const [quoteText, historyText] = await Promise.all([fetchText(quoteUrl), fetchText(historyUrl)]);
  const quoteRows = parseCsv(quoteText);
  const historyRows = parseCsv(historyText);

  if (quoteRows.length === 0 || historyRows.length < 2) {
    throw new Error('Symbol not found or insufficient data');
  }

  const quote = quoteRows[0];
  const sortedHistory = historyRows.sort((a, b) => a.Date.localeCompare(b.Date));

  const currentPrice = toNumber(quote.Close);
  const latestIndex = sortedHistory.length - 1;
  const latestRow = sortedHistory[latestIndex];
  const yesterdayRow = sortedHistory[latestIndex - 1];

  const yesterdayClose = toNumber(yesterdayRow?.Close);

  if (currentPrice === null || yesterdayClose === null) {
    throw new Error('Missing market price data');
  }

  const fiveTradingDaysAgoIndex = latestIndex - 5;
  const fiveDaysRow = fiveTradingDaysAgoIndex >= 0 ? sortedHistory[fiveTradingDaysAgoIndex] : null;

  const latestDate = new Date(`${latestRow.Date}T00:00:00Z`);
  const prevMonthDate = previousMonthSameDay(latestDate);
  const prevMonthRow = findRowForTargetDate(sortedHistory, prevMonthDate);

  const fiveDaysOpen = toNumber(fiveDaysRow?.Open);
  const previousMonthSameDayOpen = toNumber(prevMonthRow?.Open);

  if (fiveDaysOpen === null || previousMonthSameDayOpen === null) {
    throw new Error('Insufficient historical data');
  }

  return {
    symbol: marketSymbol.replace('.US', ''),
    currentPrice,
    yesterdayClose,
    fiveDaysAgoOpen: fiveDaysOpen,
    previousMonthSameDayOpen,
    changes: {
      yesterdayToCurrentPct: pctChange(yesterdayClose, currentPrice),
      fiveDaysOpenToCurrentPct: pctChange(fiveDaysOpen, currentPrice),
      previousMonthOpenToCurrentPct: pctChange(previousMonthSameDayOpen, currentPrice)
    }
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const absPath = path.join(PUBLIC_DIR, filePath);

  if (!absPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && parsed.pathname.startsWith('/api/stock/')) {
    const symbol = parsed.pathname.replace('/api/stock/', '');

    try {
      const result = await getStockMetrics(symbol);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=UTF-8' });
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
