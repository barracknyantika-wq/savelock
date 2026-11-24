function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthOf(date) {
  return date?.slice(0, 7) || null;
}

function monthLabel(month) {
  const [year, value] = month.split('-').map(Number);
  return new Date(year, value - 1, 1).toLocaleDateString('en-KE', { month: 'short', year: '2-digit' });
}

function dateLabel(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

function monthSequence(endMonth, count = 6) {
  const [year, month] = endMonth.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(year, month - count + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}

export function isReportableExpense(item) {
  if (!item || (item.direction && item.direction !== 'Expense')) return false;
  if (['savings-transfer', 'loan_reminder', 'loan-reminder'].includes(String(item.classification || item.type || '').toLowerCase())) return false;
  const category = String(item.category || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  return ![
    'savings',
    'savings transfer',
    'income',
    'other income',
    'loan reminder',
    'loan repayment',
    'fuliza repayment',
    'fuliza interest',
    'fuliza activation',
  ].includes(category);
}

function savedReportTransactions(state) {
  const reportsByMonth = new Map((state.monthlyReports || []).map((report) => [report.month, report.transactions || []]));
  const transactions = [];

  for (const [direction, entries] of [
    ['Expense', [...(state.spendLog || []), ...(state.day?.spends || [])]],
    ['Income', state.incomeLog || []],
  ]) {
    for (const entry of entries) {
      const date = localDate(entry.at);
      if (!date || reportsByMonth.has(monthOf(date))) continue;
      if (direction === 'Expense' && !isReportableExpense(entry)) continue;
      transactions.push({
        date,
        category: entry.category || (direction === 'Income' ? entry.provider || 'Income' : 'Other'),
        amount: Number(entry.amount) || 0,
        direction,
      });
    }
  }

  for (const [month, reportTransactions] of reportsByMonth) {
    for (const item of reportTransactions) {
      if (!item.date || monthOf(item.date) !== month) continue;
      if (item.direction === 'Expense' && !isReportableExpense(item)) continue;
      if (item.direction !== 'Expense' && item.direction !== 'Income') continue;
      transactions.push({
        date: item.date,
        category: item.category || (item.direction === 'Income' ? 'Income' : 'Other'),
        amount: Number(item.amount) || 0,
        direction: item.direction,
      });
    }
  }
  return transactions.filter((item) => item.amount > 0);
}

function dateSequence(range, selectedMonth, now) {
  const today = localDate(now);
  const endDate = monthOf(today) === selectedMonth
    ? today
    : `${selectedMonth}-${String(new Date(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  const end = new Date(`${endDate}T12:00:00`);
  const [year, month, day] = endDate.split('-').map(Number);
  const start = range === '6m'
    ? new Date(year, month - 6, 1)
    : new Date(year, month - 1, day - (range === '7d' ? 6 : 29));
  const dates = [];
  for (let cursor = start; cursor <= end; cursor.setDate(cursor.getDate() + 1)) dates.push(localDate(cursor));
  return dates;
}

export function getReportMonthOptions(state, now = new Date()) {
  const months = new Set([monthOf(localDate(now))]);
  for (const item of savedReportTransactions(state)) months.add(monthOf(item.date));
  for (const day of state.history || []) if (day.date) months.add(monthOf(day.date));
  for (const report of state.monthlyReports || []) if (report.month) months.add(report.month);
  return [...months]
    .filter(Boolean)
    .sort()
    .reverse()
    .map((month) => ({ value: month, label: monthLabel(month) }));
}

export function buildReportChartData(state, selectedMonth, range = '30d', now = new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth)) throw new Error('Chart month must use YYYY-MM format.');
  if (!['7d', '30d', '6m'].includes(range)) throw new Error('Chart range must be 7d, 30d, or 6m.');

  const transactions = savedReportTransactions(state);
  const monthTransactions = transactions.filter((item) => monthOf(item.date) === selectedMonth);
  const categories = new Map();
  for (const item of monthTransactions) {
    if (item.direction === 'Expense') categories.set(item.category, (categories.get(item.category) || 0) + item.amount);
  }

  const dailyTotals = new Map();
  for (const day of state.history || []) {
    if (day.date) dailyTotals.set(day.date, Number(day.spent) || 0);
  }
  const detailedDays = new Map();
  for (const item of transactions) {
    if (item.direction !== 'Expense') continue;
    detailedDays.set(item.date, (detailedDays.get(item.date) || 0) + item.amount);
  }
  for (const [date, total] of detailedDays) dailyTotals.set(date, total);

  const dates = dateSequence(range, selectedMonth, now);
  const months = monthSequence(selectedMonth);
  const monthlyExpenses = months.map((month) => transactions
    .filter((item) => item.direction === 'Expense' && monthOf(item.date) === month)
    .reduce((sum, item) => sum + item.amount, 0));
  const monthlyIncome = months.map((month) => transactions
    .filter((item) => item.direction === 'Income' && monthOf(item.date) === month)
    .reduce((sum, item) => sum + item.amount, 0));
  const previous = monthlyExpenses[monthlyExpenses.length - 2];
  const current = monthlyExpenses[monthlyExpenses.length - 1];
  const changePercent = previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
  const changeLabel = changePercent === null
    ? (current > 0 ? 'New spending vs previous month' : '0% vs previous month')
    : `${changePercent > 0 ? '+' : ''}${changePercent}% vs previous month`;

  const hasExpenses = monthTransactions.some((item) => item.direction === 'Expense');
  const hasIncome = transactions.some((item) => item.direction === 'Income');
  return {
    selectedMonth,
    monthLabel: monthLabel(selectedMonth),
    monthOptions: getReportMonthOptions(state, now),
    range,
    currency: state.settings?.currency || 'KSh',
    hasExpenses,
    hasIncome,
    hasAnyData: hasExpenses || hasIncome,
    categories: {
      labels: [...categories.keys()],
      values: [...categories.values()],
    },
    daily: {
      labels: dates.map(dateLabel),
      dates,
      values: dates.map((date) => dailyTotals.get(date) || 0),
      budget: Number(state.settings?.dailyLimit) || 0,
    },
    monthly: {
      labels: months.map(monthLabel),
      values: monthlyExpenses,
      changePercent,
      changeLabel,
      changeDirection: changePercent === null || changePercent === 0 ? 'flat' : changePercent < 0 ? 'down' : 'up',
    },
    incomeExpense: {
      labels: months.map(monthLabel),
      income: monthlyIncome,
      expenses: monthlyExpenses,
    },
  };
}
