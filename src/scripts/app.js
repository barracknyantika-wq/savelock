import Alpine from 'alpinejs';
import { registerStore, parseAmount, todayStr } from './store.js';

window.Alpine = Alpine;
registerStore(Alpine);

const store = () => Alpine.store('sl');

Alpine.data('todayPage', () => ({
  sheet: false,
  amount: '',
  note: '',
  limitInput: '',
  quick: [50, 100, 200],

  openSheet() {
    this.sheet = true;
    this.$nextTick(() => this.$refs.amountInput?.focus());
  },

  logQuick(v) {
    store().logSpend(v);
    if (navigator.vibrate) navigator.vibrate(15);
  },

  submitSpend() {
    const v = parseAmount(this.amount);
    if (!v) return;
    store().logSpend(v, this.note.trim());
    this.amount = '';
    this.note = '';
    this.sheet = false;
  },

  saveLimit() {
    const v = parseAmount(this.limitInput);
    if (!v) return;
    store().setLimit(v);
    this.limitInput = '';
  },
}));

Alpine.data('goalsPage', () => ({
  newSheet: false,
  gName: '',
  gTarget: '',
  gDate: '',
  updSheet: false,
  updId: null,
  updName: '',
  updAmount: '',
  breakId: null,
  breakText: '',
  minDate: todayStr(),

  openNew() {
    this.gName = '';
    this.gTarget = '';
    this.gDate = '';
    this.newSheet = true;
  },

  submitNew() {
    const target = parseAmount(this.gTarget);
    const name = this.gName.trim();
    if (!name || !target || !this.gDate) return;
    store().addGoal(name, target, this.gDate);
    this.newSheet = false;
  },

  openUpdate(g) {
    this.updId = g.id;
    this.updName = g.name;
    this.updAmount = g.saved > 0 ? String(g.saved) : '';
    this.updSheet = true;
    this.$nextTick(() => this.$refs.updInput?.focus());
  },

  submitUpdate() {
    const v = parseAmount(this.updAmount);
    if (v === null) return;
    store().updateSaved(this.updId, v);
    this.updSheet = false;
  },

  get breakGoal() {
    return store().goals.find((g) => g.id === this.breakId) || null;
  },

  startBreak(g) {
    this.breakId = g.id;
    this.breakText = '';
  },

  confirmBreak() {
    if (this.breakText.trim() !== 'YES') return;
    store().breakGoal(this.breakId);
    this.breakId = null;
    this.breakText = '';
  },
}));

Alpine.data('settingsPage', () => ({
  limitInput: '',
  currencyInput: '',
  importError: '',
  importOk: false,
  eraseArmed: false,

  init() {
    const s = store();
    this.limitInput = s.settings.dailyLimit > 0 ? String(s.settings.dailyLimit) : '';
    this.currencyInput = s.settings.currency;
  },

  saveLimit() {
    const v = parseAmount(this.limitInput);
    if (!v) return;
    store().setLimit(v);
  },

  saveCurrency() {
    store().setCurrency(this.currencyInput);
    this.currencyInput = store().settings.currency;
  },

  exportBackup() {
    const blob = new Blob([store().exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `savelock-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },

  async importBackup(event) {
    this.importError = '';
    this.importOk = false;
    const file = event.target.files?.[0];
    if (!file) return;
    const err = store().importData(await file.text());
    if (err) {
      this.importError = err;
      event.target.value = '';
    } else {
      this.importOk = true;
      setTimeout(() => location.reload(), 600);
    }
  },

  erase() {
    if (!this.eraseArmed) {
      this.eraseArmed = true;
      setTimeout(() => (this.eraseArmed = false), 4000);
      return;
    }
    store().eraseAll();
    this.eraseArmed = false;
    this.limitInput = '';
  },
}));

Alpine.start();
