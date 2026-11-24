import assert from 'node:assert/strict';
import { createMonthlyReport, nextMonth, previousMonth } from '../src/scripts/monthly-reports.js';
import { buildReportChartData, isReportableExpense } from '../src/scripts/report-chart-data.js';

const at = (day) => new Date(2025, 2, day, 12).getTime();
const state = {
  settings: { currency: 'KSh' },
  day: {
    spends: [
      { amount: 120, note: 'Groceries', category: 'Food', at: at(5) },
      { amount: 500, note: 'Goal deposit', category: 'Savings', classification: 'savings-transfer', at: at(6) },
      { amount: 40, note: 'Loan reminder', category: 'loan_reminder', classification: 'loan_reminder', at: at(7) },
    ],
  },
  spendLog: [{ amount: 30, note: 'Bus', category: 'Transport', at: at(8) }],
  incomeLog: [{ amount: 500, note: 'Salary', category: 'Income', at: at(9) }],
  history: [
    { date: '2025-03-05', limit: 200, spent: 120 },
    { date: '2025-03-06', limit: 200, spent: 240 },
  ],
  goals: [{
    savedHistory: [
      { at: new Date(2025, 1, 28, 12).toISOString(), amount: 0 },
      { at: new Date(2025, 2, 8, 12).toISOString(), amount: 100 },
      { at: new Date(2025, 2, 9, 12).toISOString(), amount: 120 },
    ],
  }],
};

assert.equal(previousMonth(new Date(2025, 0, 15)), '2024-12');
assert.equal(nextMonth('2024-12'), '2025-01');

const report = await createMonthlyReport(state, '2025-03', { name: 'Test User' }, new Date(2025, 3, 1));
assert.equal(report.summary.income, 500);
assert.equal(report.summary.expenses, 150);
assert.equal(report.summary.netSavings, 350);
assert.deepEqual(report.summary.categoryBreakdown, [
  { category: 'Food', total: 120 },
  { category: 'Transport', total: 30 },
]);
assert.equal(report.transactions.length, 3, 'savings transfers and loan reminders are excluded');
assert.equal(report.streaks.budget.daysOnTrack, 1);
assert.equal(report.streaks.budget.daysMeasured, 2);
assert.equal(report.streaks.savings.daysOnTrack, 2);
assert.equal(report.streaks.savings.longestRun, 2);
assert.ok(report.pdfBase64.length > 1000);
assert.equal(atob(report.pdfBase64.slice(0, 40)).slice(0, 4), '%PDF');
await assert.rejects(() => createMonthlyReport(state, '2025-13'), /YYYY-MM/);

assert.equal(isReportableExpense({ category: 'Savings' }), false);
assert.equal(isReportableExpense({ category: 'Food', classification: 'loan_reminder' }), false);
assert.equal(isReportableExpense({ category: 'Food', direction: 'Income' }), false);
assert.equal(isReportableExpense({ category: 'Food' }), true);

const chartState = {
  settings: { currency: 'KSh', dailyLimit: 200 },
  day: { spends: [{ amount: 25, category: 'Food', at: new Date(2025, 2, 31, 12).getTime() }] },
  spendLog: [
    { amount: 50, category: 'Food', at: new Date(2025, 2, 30, 12).getTime() },
    { amount: 80, category: 'Bills', at: new Date(2025, 1, 15, 12).getTime() },
    { amount: 999, category: 'Savings', at: new Date(2025, 2, 29, 12).getTime() },
    { amount: 300, category: 'Other', classification: 'loan_reminder', at: new Date(2025, 2, 28, 12).getTime() },
  ],
  incomeLog: [{ amount: 500, category: 'Income', at: new Date(2025, 2, 20, 12).getTime() }],
  history: [{ date: '2025-03-29', spent: 0 }, { date: '2025-02-15', spent: 80 }],
};
const chartData = buildReportChartData(chartState, '2025-03', '7d', new Date(2025, 2, 31, 12));
assert.equal(chartData.hasExpenses, true);
assert.equal(chartData.hasIncome, true);
assert.deepEqual(chartData.categories, { labels: ['Food'], values: [75] });
assert.deepEqual(chartData.monthly.values, [0, 0, 0, 0, 80, 75]);
assert.deepEqual(chartData.incomeExpense.income, [0, 0, 0, 0, 0, 500]);
assert.equal(chartData.daily.labels.length, 7);
assert.equal(chartData.daily.budget, 200);
assert.equal(chartData.monthly.changePercent, -6);
assert.equal(chartData.monthly.changeLabel, '-6% vs previous month');
const sixMonthChart = buildReportChartData(chartState, '2025-03', '6m', new Date(2025, 2, 31, 12));
assert.equal(sixMonthChart.daily.dates[0], '2024-10-01');
assert.equal(sixMonthChart.daily.dates.at(-1), '2025-03-31');

console.log('Passed monthly report totals, chart exclusions and series, streaks, date boundaries, and PDF output.');
