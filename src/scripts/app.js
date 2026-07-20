import Alpine from 'alpinejs';
import { registerStore, parseAmount, todayStr, BADGE_DEFS } from './store.js';
import { tickGauge, sketchBars, categoryBars, squiggle, handCheck } from './viz.js';
import {
  isNative,
  initNativeBridge,
  pushNotificationPrefs,
  checkSmsPermission,
  requestSmsPermission,
  nativeReload,
  syncReminders,
  syncWeeklySummary,
} from './native-bridge.js';
import {
  isCloudConfigured,
  initCloudSync,
  getSession,
  onAuthStateChange,
  sendOtp,
  verifyOtp,
  signOut as cloudSignOut,
  hasRemoteData,
  pullState,
  pushState,
} from './cloud-sync.js';

window.Alpine = Alpine;
registerStore(Alpine);

const store = () => Alpine.store('sl');

// hand-feel SVG snippets, available in every x-data scope
Alpine.magic('squiggle', () => squiggle);
Alpine.magic('handCheck', () => handCheck);
Alpine.magic('gauge', () => (ratio, opts) => tickGauge(ratio, opts));

// A single global toast, shared by every page (rendered once in Layout.astro)
// so any edit — a spend, a goal, a setting — gets the same immediate,
// unmissable "did that work?" confirmation, however it was triggered.
const TOAST_MS = 2200;
Alpine.store('toast', {
  message: '',
  _timer: null,
  show(message) {
    this.message = message;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => (this.message = ''), TOAST_MS);
  },
});
function toast(message) {
  Alpine.store('toast').show(message);
}
Alpine.magic('toast', () => toast);

const MILESTONE_COPY = {
  25: (name) => `Quarter of the way to ${name} — keep going.`,
  50: (name) => `Halfway to ${name}. Nice pace.`,
  75: (name) => `75% there — ${name} is almost within reach.`,
  100: (name) => `${name} is fully funded!`,
};

// Picks the single highest newly-crossed threshold to announce, so a big
// jump across several milestones at once still reads as one clean moment.
function milestoneText(milestones, goalName) {
  if (!milestones?.length) return '';
  const top = Math.max(...milestones);
  return MILESTONE_COPY[top]?.(goalName) || '';
}

Alpine.data('todayPage', () => ({
  sheet: false,
  amount: '',
  note: '',
  category: 'Other',
  limitInput: '',
  quick: [50, 100, 200],
  reclassifyId: null,
  categoryEditId: null,
  confirmBanner: '',
  insightDays: 7,

  get allowanceGauge() {
    const s = store();
    return tickGauge(s.remainingRatio, { low: s.remainingRatio < 0.25 });
  },

  get historyChart() {
    return sketchBars(store().last7);
  },

  get reclassifySpend() {
    return store().day.spends.find((s) => s.id === this.reclassifyId) || null;
  },

  get categoryEditSpend() {
    return store().day.spends.find((s) => s.id === this.categoryEditId) || null;
  },

  get activeGoals() {
    return store().activeGoals;
  },

  get categories() {
    return store().settings.categories;
  },

  get insightBreakdown() {
    return store().categoryBreakdown(this.insightDays);
  },

  get insightChart() {
    return categoryBars(this.insightBreakdown);
  },

  get topCategories() {
    return store().topCategories(this.insightDays, 3);
  },

  get insightTotal() {
    return this.insightBreakdown.reduce((s, c) => s + c.total, 0);
  },

  openSheet() {
    this.category = 'Other';
    this.sheet = true;
    this.$nextTick(() => this.$refs.amountInput?.focus());
  },

  openReclassify(spendId) {
    this.reclassifyId = spendId;
  },

  openCategoryEdit(spendId) {
    this.categoryEditId = spendId;
  },

  setCategory(category) {
    store().setSpendCategory(this.categoryEditId, category);
    this.categoryEditId = null;
    toast('Updated');
  },

  confirmReclassify(goalId) {
    const spend = this.reclassifySpend;
    const res = store().reclassifyAsSavings(this.reclassifyId, goalId);
    this.reclassifyId = null;
    if (!res) return;
    const milestone = milestoneText(res.milestones, res.goal.name);
    this.confirmBanner = `${store().money(spend.amount)} moved to savings — added to your goal, not counted as spending.${milestone ? ' ' + milestone : ''}`;
    setTimeout(() => (this.confirmBanner = ''), 5000);
  },

  logQuick(v) {
    store().logSpend(v);
    if (navigator.vibrate) navigator.vibrate(15);
    toast('Logged');
  },

  submitSpend() {
    const v = parseAmount(this.amount);
    if (!v) return;
    store().logSpend(v, this.note.trim(), this.category);
    this.amount = '';
    this.note = '';
    this.category = 'Other';
    this.sheet = false;
    toast('Logged');
  },

  saveLimit() {
    const v = parseAmount(this.limitInput);
    if (!v) return;
    store().setLimit(v);
    this.limitInput = '';
    toast('Saved');
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
  milestoneBanner: '',
  minDate: todayStr(),

  goalGauge(g) {
    return tickGauge(store().progress(g));
  },

  projectedDate(g) {
    const d = store().projectedFinishDate(g);
    return d ? store().dateShort(d) : null;
  },

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
    toast('Goal added');
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
    const goal = store().goals.find((g) => g.id === this.updId);
    const milestones = store().updateSaved(this.updId, v);
    this.updSheet = false;
    const text = milestoneText(milestones, goal?.name || '');
    if (text) {
      this.milestoneBanner = text;
      setTimeout(() => (this.milestoneBanner = ''), 5000);
    }
    toast('Updated');
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
    toast('Recorded');
  },
}));

Alpine.data('settingsPage', () => ({
  limitInput: '',
  currencyInput: '',
  importError: '',
  importOk: false,
  eraseArmed: false,
  native: isNative(),
  smsPermState: null,
  newCategory: '',
  renamingCategory: null,
  renameInput: '',

  async init() {
    const s = store();
    this.limitInput = s.settings.dailyLimit > 0 ? String(s.settings.dailyLimit) : '';
    this.currencyInput = s.settings.currency;
    if (this.native) this.smsPermState = await checkSmsPermission();
  },

  get smsGranted() {
    return this.smsPermState?.sms === 'granted';
  },

  get smsDenied() {
    return this.smsPermState?.sms === 'denied';
  },

  async enableSmsDetection() {
    this.smsPermState = await requestSmsPermission();
    if (this.smsGranted) pushNotificationPrefs(store());
  },

  toggleSmsNotifySpend() {
    store().setSmsNotifySpend(!store().settings.smsNotifySpend);
    pushNotificationPrefs(store());
    toast('Saved');
  },

  toggleSmsNotifyReceived() {
    store().setSmsNotifyReceived(!store().settings.smsNotifyReceived);
    pushNotificationPrefs(store());
    toast('Saved');
  },

  setSmsNotifyMode(mode) {
    store().setSmsNotifyMode(mode);
    pushNotificationPrefs(store());
    toast('Saved');
  },

  addCategory() {
    if (!this.newCategory.trim()) return;
    store().addCategory(this.newCategory);
    this.newCategory = '';
    toast('Added');
  },

  startRename(cat) {
    this.renamingCategory = cat;
    this.renameInput = cat;
  },

  submitRename() {
    store().renameCategory(this.renamingCategory, this.renameInput);
    this.renamingCategory = null;
    this.renameInput = '';
    toast('Updated');
  },

  removeCategory(cat) {
    store().removeCategory(cat);
    toast('Removed');
  },

  toggleMorningReminder() {
    store().setReminderMorning(!store().settings.reminderMorningEnabled);
    syncReminders(store());
    toast('Saved');
  },

  toggleEveningReminder() {
    store().setReminderEvening(!store().settings.reminderEveningEnabled);
    syncReminders(store());
    toast('Saved');
  },

  saveReminderTimes() {
    store().setReminderMorning(store().settings.reminderMorningEnabled, store().settings.reminderMorningTime);
    store().setReminderEvening(store().settings.reminderEveningEnabled, store().settings.reminderEveningTime);
    syncReminders(store());
    toast('Saved');
  },

  toggleWeeklySummary() {
    store().setWeeklySummary(!store().settings.weeklySummaryEnabled);
    syncWeeklySummary(store());
    toast('Saved');
  },

  saveLimit() {
    const v = parseAmount(this.limitInput);
    if (!v) return;
    store().setLimit(v);
    toast('Saved');
  },

  saveCurrency() {
    store().setCurrency(this.currencyInput);
    this.currencyInput = store().settings.currency;
    toast('Saved');
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
    toast('Exported');
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
      setTimeout(() => nativeReload(), 600);
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

Alpine.data('badgesPage', () => ({
  challengeInput: '',

  get badgeDefs() {
    return BADGE_DEFS;
  },

  isEarned(id) {
    return store().earnedBadgeIds.includes(id);
  },

  earnedAt(id) {
    const b = store().badges.find((x) => x.id === id);
    return b ? store().dateShort(b.earnedAt) : null;
  },

  get stats() {
    return store().stats;
  },

  get challenge() {
    return store().challenge;
  },

  get challengeSavedSoFar() {
    return store().challengeSavedSoFar();
  },

  get challengeDaysLeft() {
    return store().challengeDaysLeft();
  },

  get challengeHistory() {
    return [...store().challengeHistory].reverse();
  },

  startChallenge() {
    const v = parseAmount(this.challengeInput);
    if (!v) return;
    if (store().startChallenge(v)) {
      this.challengeInput = '';
      toast('Challenge started');
    }
  },

  cancelChallenge() {
    store().cancelChallenge();
    toast('Cancelled');
  },
}));

Alpine.data('accountPage', () => ({
  cloudConfigured: isCloudConfigured(),
  session: null,
  phone: '',
  otp: '',
  // 'phone' | 'otp' | 'reconcile' | 'import' | 'signed-in'
  stage: 'phone',
  error: '',
  busy: false,

  async init() {
    if (!this.cloudConfigured) return;
    this.session = await getSession();
    if (this.session) this.stage = 'signed-in';
    onAuthStateChange((session) => {
      this.session = session;
    });
  },

  get phoneOnFile() {
    return this.session?.user?.phone ? `+${this.session.user.phone}` : '';
  },

  localHasData() {
    const s = store();
    return s.settings.dailyLimit > 0 || s.goals.length > 0 || s.spendLog.length > 0 || s.day.spends.length > 0;
  },

  async sendCode() {
    this.error = '';
    const phone = this.phone.trim();
    if (!phone) return;
    this.busy = true;
    const { error } = await sendOtp(phone);
    this.busy = false;
    if (error) {
      this.error = error;
      return;
    }
    this.stage = 'otp';
    toast('Code sent');
  },

  async verifyCode() {
    this.error = '';
    if (!this.otp.trim()) return;
    this.busy = true;
    const { error, session } = await verifyOtp(this.phone.trim(), this.otp.trim());
    this.busy = false;
    if (error) {
      this.error = error;
      return;
    }
    this.session = session;
    await this.reconcile();
  },

  async reconcile() {
    const userId = this.session.user.id;
    const remoteHasData = await hasRemoteData(userId);
    const localData = this.localHasData();
    if (remoteHasData && localData) {
      this.stage = 'reconcile';
    } else if (remoteHasData && !localData) {
      await this.pullNow();
      this.stage = 'signed-in';
      toast('Synced');
    } else if (!remoteHasData && localData) {
      this.stage = 'import';
    } else {
      this.stage = 'signed-in';
    }
  },

  async pullNow() {
    const remote = await pullState();
    if (remote) {
      Object.assign(store(), remote);
      store().persist();
    }
  },

  async importLocalData() {
    this.busy = true;
    await pushState(store());
    this.busy = false;
    this.stage = 'signed-in';
    toast('Imported');
  },

  async useAccountData() {
    this.busy = true;
    await this.pullNow();
    this.busy = false;
    this.stage = 'signed-in';
    toast('Synced');
  },

  async keepThisDevice() {
    this.busy = true;
    await pushState(store());
    this.busy = false;
    this.stage = 'signed-in';
    toast('Synced');
  },

  async signOutOfAccount() {
    await cloudSignOut();
    this.session = null;
    this.stage = 'phone';
    this.phone = '';
    this.otp = '';
    toast('Signed out');
  },
}));

Alpine.start();
initNativeBridge(store());
initCloudSync(store());
