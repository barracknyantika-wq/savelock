import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { buildReportChartData } from './report-chart-data.js';

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
);

const COLORS = {
  ochre: '#c9922e',
  ochreSoft: '#b07e1f',
  cream: '#f4f1ea',
  muted: '#b3ab9a',
  green: '#71b597',
  red: '#e07856',
  grid: 'rgba(244, 241, 234, 0.12)',
};

function formatMoney(value, currency) {
  return `${currency} ${Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    color: COLORS.muted,
    font: { family: 'Outfit Variable, system-ui, sans-serif' },
    plugins: {
      legend: {
        labels: { color: COLORS.cream, usePointStyle: true, boxWidth: 8, padding: 14 },
      },
      tooltip: {
        callbacks: {
          label(context) {
            const value = typeof context.parsed === 'number' ? context.parsed : context.parsed.y;
            return `${context.dataset.label || context.label}: ${formatMoney(value, context.chart.$currency)}`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: {
          color: COLORS.muted,
          callback(value) { return formatMoney(value, this.chart.$currency); },
          maxTicksLimit: 5,
        },
        grid: { color: COLORS.grid },
        border: { display: false },
      },
    },
  };
}

function makeChart(canvas, type, data, currency, extraOptions = {}) {
  const options = {
    ...chartDefaults(),
    ...extraOptions,
    plugins: { ...chartDefaults().plugins, ...(extraOptions.plugins || {}) },
  };
  const chart = new Chart(canvas, { type, data, options });
  chart.$currency = currency;
  return chart;
}

export function renderReportCharts(canvases, model) {
  const charts = [];
  if (canvases.categories && model.categories.labels.length) {
    charts.push(makeChart(canvases.categories, 'doughnut', {
      labels: model.categories.labels,
      datasets: [{
        data: model.categories.values,
        backgroundColor: [COLORS.ochre, '#71b597', '#7194b5', '#b57c71', '#9c87bd', '#c4b878'],
        borderColor: '#1c1915',
        borderWidth: 3,
        hoverOffset: 5,
      }],
    }, model.currency, {
      cutout: '62%',
      plugins: { legend: { position: 'bottom' } },
      scales: undefined,
    }));
  }

  if (canvases.daily && model.daily.values.some((value) => value > 0)) {
    charts.push(makeChart(canvases.daily, 'line', {
      labels: model.daily.labels,
      datasets: [
        {
          label: 'Spending',
          data: model.daily.values,
          borderColor: COLORS.ochre,
          backgroundColor: 'rgba(201, 146, 46, 0.16)',
          pointBackgroundColor: COLORS.ochre,
          pointRadius: model.range === '6m' ? 0 : 2,
          borderWidth: 2,
          fill: true,
          tension: 0.28,
        },
        {
          label: 'Daily budget',
          data: model.daily.values.map(() => model.daily.budget),
          borderColor: COLORS.green,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [6, 5],
          fill: false,
        },
      ],
    }, model.currency));
  }

  if (canvases.monthly && model.hasExpenses) {
    charts.push(makeChart(canvases.monthly, 'bar', {
      labels: model.monthly.labels,
      datasets: [{
        label: 'Expenses',
        data: model.monthly.values,
        backgroundColor: model.monthly.values.map((_, index) =>
          index === model.monthly.values.length - 1
            ? model.monthly.changeDirection === 'down' ? COLORS.green : model.monthly.changeDirection === 'up' ? COLORS.red : COLORS.ochre
            : 'rgba(201, 146, 46, 0.68)'),
        borderRadius: 5,
        maxBarThickness: 36,
      }],
    }, model.currency, { plugins: { legend: { display: false } } }));
  }

  if (canvases.incomeExpense && model.hasAnyData) {
    charts.push(makeChart(canvases.incomeExpense, 'bar', {
      labels: model.incomeExpense.labels,
      datasets: [
        { label: 'Income', data: model.incomeExpense.income, backgroundColor: COLORS.green, borderRadius: 4, maxBarThickness: 28 },
        { label: 'Expenses', data: model.incomeExpense.expenses, backgroundColor: COLORS.ochre, borderRadius: 4, maxBarThickness: 28 },
      ],
    }, model.currency));
  }
  return { destroy: () => charts.forEach((chart) => chart.destroy()) };
}

export function renderChartToDataUrl(type, data, width, height, currency = 'KSh', options = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas for the report chart.');
  context.fillStyle = '#f4f1ea';
  context.fillRect(0, 0, width, height);
  const chartOptions = {
    ...chartDefaults(),
    responsive: false,
    animation: false,
    color: '#5c564a',
    plugins: {
      ...chartDefaults().plugins,
      legend: { labels: { color: '#5c564a', boxWidth: 9, padding: 12 } },
    },
    scales: {
      x: { ticks: { color: '#5c564a', maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false }, border: { display: false } },
      y: { beginAtZero: true, ticks: { color: '#5c564a', callback(value) { return formatMoney(value, currency); }, maxTicksLimit: 4 }, grid: { color: 'rgba(33, 30, 25, 0.12)' }, border: { display: false } },
    },
    ...options,
  };
  const chart = new Chart(canvas, { type, data, options: chartOptions });
  chart.$currency = currency;
  chart.update('none');
  const image = canvas.toDataURL('image/png');
  chart.destroy();
  return image;
}

export { buildReportChartData };
