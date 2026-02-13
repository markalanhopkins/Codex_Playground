const form = document.getElementById('symbol-form');
const input = document.getElementById('symbol-input');
const cardsContainer = document.getElementById('cards');
const errorEl = document.getElementById('error');

const symbols = new Set();

function classForValue(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function formatPct(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function upsertCard(data) {
  const id = `card-${data.symbol}`;
  let card = document.getElementById(id);

  const rows = [
    {
      label: "Yesterday close -> current",
      value: data.changes.yesterdayToCurrentPct
    },
    {
      label: 'Open 5 days ago -> current',
      value: data.changes.fiveDaysOpenToCurrentPct
    },
    {
      label: 'Open previous month same date -> current',
      value: data.changes.previousMonthOpenToCurrentPct
    }
  ];

  if (!card) {
    card = document.createElement('article');
    card.className = 'card';
    card.id = id;
    cardsContainer.appendChild(card);
  }

  card.innerHTML = `
    <h2>${data.symbol}</h2>
    ${rows
      .map(
        (row) => `
      <div class="metric">
        <span class="metric-label">${row.label}</span>
        <span class="metric-value ${classForValue(row.value)}">${formatPct(row.value)}</span>
      </div>
    `
      )
      .join('')}
  `;
}

async function addSymbol(rawSymbol) {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) return;

  errorEl.textContent = '';

  if (symbols.has(symbol)) {
    return;
  }

  try {
    const response = await fetch(`/api/stock/${encodeURIComponent(symbol)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not fetch symbol.');
    }

    symbols.add(symbol);
    upsertCard(data);
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await addSymbol(input.value);
  input.value = '';
  input.focus();
});

addSymbol('NVDA');
