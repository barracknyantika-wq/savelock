function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthOf(value) {
  const date = localDate(value);
  return date ? date.slice(0, 7) : null;
}

function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${month}-01`;
  const endDate = new Date(year, monthNumber, 0);
  return {
    start,
    end: `${month}-${String(endDate.getDate()).padStart(2, '0')}`,
    days: endDate.getDate(),
  };
}

function money(value, currency) {
  return `${currency} ${Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
}

function longestConsecutiveRun(dates) {
  const ordered = [...new Set(dates)].sort();
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const date of ordered) {
    const adjacent = previous && (new Date(`${date}T00:00:00`) - new Date(`${previous}T00:00:00`)) / 86400000 === 1;
    run = adjacent ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  return longest;
}

function savingsProgressDates(goals) {
  const dates = [];
  for (const goal of goals || []) {
    const history = [...(goal.savedHistory || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
    let previousAmount = 0;
    for (const entry of history) {
      const currentAmount = Number(entry.amount);
      const date = localDate(entry.at);
      if (date && Number.isFinite(currentAmount) && currentAmount > previousAmount) dates.push(date);
      if (Number.isFinite(currentAmount)) previousAmount = currentAmount;
    }
  }
  return dates;
}

function streakPerformance(dates, measuredDays, periodDays) {
  const uniqueDates = [...new Set(dates)];
  return {
    daysOnTrack: uniqueDates.length,
    daysMeasured: measuredDays,
    longestRun: longestConsecutiveRun(uniqueDates),
    percentage: periodDays ? Math.round((uniqueDates.length / periodDays) * 100) : 0,
  };
}

export function previousMonth(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function nextMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export async function createMonthlyReport(state, month, user = {}, generatedAt = new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Monthly report month must use YYYY-MM format.');
  const { start, end, days } = monthBounds(month);
  const transactions = [];

  for (const spend of [...(state.spendLog || []), ...(state.day?.spends || [])]) {
    const date = localDate(spend.at);
    if (!date || date.slice(0, 7) !== month || spend.classification === 'savings-transfer' || spend.classification === 'loan_reminder') continue;
    transactions.push({
      date,
      description: spend.note || spend.counterparty || 'Spend',
      category: spend.category || 'Other',
      amount: Number(spend.amount) || 0,
      direction: 'Expense',
    });
  }

  for (const income of state.incomeLog || []) {
    const date = localDate(income.at);
    if (!date || date.slice(0, 7) !== month) continue;
    transactions.push({
      date,
      description: income.note || income.counterparty || 'Income',
      category: income.category || income.provider || 'Income',
      amount: Number(income.amount) || 0,
      direction: 'Income',
    });
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  const incomeTotal = transactions.filter((item) => item.direction === 'Income').reduce((total, item) => total + item.amount, 0);
  const expenseItems = transactions.filter((item) => item.direction === 'Expense');
  const expenseTotal = expenseItems.reduce((total, item) => total + item.amount, 0);
  const categories = {};
  for (const item of expenseItems) categories[item.category] = (categories[item.category] || 0) + item.amount;

  const budgetDays = (state.history || [])
    .filter((day) => day.date.slice(0, 7) === month && day.limit > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const budgetOnTrack = budgetDays.filter((day) => day.spent <= day.limit).map((day) => day.date);
  const savingsDays = savingsProgressDates(state.goals).filter((date) => date.slice(0, 7) === month);
  const currency = state.settings?.currency || 'KSh';
  const summary = {
    income: Math.round(incomeTotal * 100) / 100,
    expenses: Math.round(expenseTotal * 100) / 100,
    netSavings: Math.round((incomeTotal - expenseTotal) * 100) / 100,
    categoryBreakdown: Object.entries(categories)
      .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total),
  };
  const streaks = {
    budget: streakPerformance(budgetOnTrack, budgetDays.length, days),
    savings: streakPerformance(savingsDays, days, days),
  };
  const generated = generatedAt.toISOString();

  return {
    id: month,
    month,
    periodStart: start,
    periodEnd: end,
    generatedAt: generated,
    userName: user.name || '',
    userIdentity: user.identity || '',
    currency,
    summary,
    streaks,
    transactions,
    pdfBase64: await renderMonthlyReportPdf({
      month,
      periodStart: start,
      periodEnd: end,
      generatedAt: generated,
      userName: user.name || '',
      userIdentity: user.identity || '',
      currency,
      summary,
      streaks,
      transactions,
    }),
    emailStatus: 'not-applicable',
    emailError: '',
  };
}

function printable(value, maxLength = 100) {
  return String(value || '')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

export async function renderMonthlyReportPdf(report) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 42;
  const contentWidth = pageWidth - margin * 2;
  const generated = new Date(report.generatedAt).toLocaleDateString('en-GB');
  const period = `${report.periodStart} to ${report.periodEnd}`;

  doc.setFillColor(26, 55, 45);
  doc.rect(0, 0, pageWidth, 112, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('SaveLock', margin, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('MONTHLY STATEMENT', margin, 62);
  doc.setFontSize(9);
  doc.text(`Statement period: ${period}`, margin, 84);
  doc.text(`Prepared for: ${printable(report.userName || report.userIdentity || 'SaveLock user', 80)}`, margin, 99);

  let y = 138;
  doc.setTextColor(35, 44, 38);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Monthly summary', margin, y);
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const summaryLines = [
    `Income  ${money(report.summary.income, report.currency)}`,
    `Expenses  ${money(report.summary.expenses, report.currency)}`,
    `Net savings  ${money(report.summary.netSavings, report.currency)}`,
  ];
  summaryLines.forEach((line, index) => {
    const x = margin + index * (contentWidth / 3);
    doc.setFillColor(244, 241, 231);
    doc.roundedRect(x, y, contentWidth / 3 - 8, 38, 5, 5, 'F');
    doc.text(line, x + 8, y + 23);
  });
  y += 58;
  doc.setFont('helvetica', 'bold');
  doc.text('Streak performance', margin, y);
  y += 15;
  doc.setFont('helvetica', 'normal');
  const budget = report.streaks.budget;
  const savings = report.streaks.savings;
  doc.text(`Budget: ${budget.daysOnTrack}/${budget.daysMeasured} measured days on track; longest run ${budget.longestRun} days`, margin, y);
  y += 14;
  doc.text(`Savings: ${savings.daysOnTrack}/${savings.daysMeasured} days with a contribution; longest run ${savings.longestRun} days`, margin, y);
  y += 28;
  doc.setFont('helvetica', 'bold');
  doc.text('Category breakdown', margin, y);
  y += 15;
  doc.setFont('helvetica', 'normal');
  if (!report.summary.categoryBreakdown.length) {
    doc.text('No classified expenses this month.', margin, y);
    y += 18;
  } else {
    for (const category of report.summary.categoryBreakdown) {
      if (y > pageHeight - 80) {
        doc.addPage();
        y = 48;
      }
      doc.text(printable(category.category, 36), margin, y);
      doc.text(money(category.total, report.currency), pageWidth - margin, y, { align: 'right' });
      y += 14;
    }
  }

  y += 12;
  const drawTableHeader = () => {
    doc.setFillColor(26, 55, 45);
    doc.rect(margin, y, contentWidth, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    const columns = [
      { title: 'Date', x: margin + 6 },
      { title: 'Description', x: margin + 67 },
      { title: 'Category', x: margin + 284 },
      { title: 'Amount', x: margin + 408 },
      { title: 'Direction', x: margin + 466 },
    ];
    for (const column of columns) doc.text(column.title, column.x, y + 14);
    y += 22;
    doc.setTextColor(35, 44, 38);
    doc.setFont('helvetica', 'normal');
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Transactions', margin, y);
  y += 12;
  drawTableHeader();
  if (!report.transactions.length) {
    doc.setFontSize(9);
    doc.text('No classified transactions this month.', margin + 6, y + 16);
    y += 28;
  } else {
    doc.setFontSize(8);
    for (const [index, item] of report.transactions.entries()) {
      if (y + 22 > pageHeight - 48) {
        doc.addPage();
        y = 48;
        drawTableHeader();
      }
      if (index % 2 === 0) {
        doc.setFillColor(248, 247, 242);
        doc.rect(margin, y, contentWidth, 21, 'F');
      }
      doc.text(item.date, margin + 6, y + 14);
      doc.text(printable(item.description, 34), margin + 67, y + 14);
      doc.text(printable(item.category, 18), margin + 284, y + 14);
      doc.text(money(item.amount, report.currency), margin + 408, y + 14);
      doc.text(item.direction, margin + 466, y + 14);
      y += 21;
    }
  }

  for (let page = 1; page <= doc.getNumberOfPages(); page++) {
    doc.setPage(page);
    doc.setDrawColor(224, 222, 213);
    doc.line(margin, pageHeight - 32, pageWidth - margin, pageHeight - 32);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 105, 99);
    doc.text(`Generated ${generated}  |  SaveLock`, margin, pageHeight - 18);
    doc.text(`${page}/${doc.getNumberOfPages()}`, pageWidth - margin, pageHeight - 18, { align: 'right' });
  }

  return doc.output('datauristring').split(',')[1];
}

export function downloadMonthlyReport(report) {
  if (!report?.pdfBase64) throw new Error('This monthly report has no saved PDF.');
  const bytes = Uint8Array.from(atob(report.pdfBase64), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `savelock-statement-${report.month}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
