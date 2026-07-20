// SaveLock data layer. Everything lives in localStorage on this device —
// the app holds no money and talks to no server.

const KEY = 'savelock:v1';
const HISTORY_CAP = 180;
const SPEND_LOG_CAP = 500;
const FULIZA_EVENTS_CAP = 200;
const MILESTONES = [25, 50, 75, 100];

export function todayStr(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function toDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr, n) {
  const d = toDate(dateStr);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

// Whole local days from `a` to `b` (positive when b is later).
export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

export function parseAmount(v) {
  const n = Math.round(parseFloat(String(v).replace(/,/g, '')) * 100) / 100;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_CATEGORIES = ['Food', 'Transport', 'Airtime', 'Bills', 'Shopping', 'Other'];

function defaultState() {
  return {
    version: 1,
    settings: {
      dailyLimit: 0,
      currency: 'KSh',
      smsNotifySpend: true,
      smsNotifyReceived: true,
      // 'always' notifies every detected spend; 'importantOnly' only
      // notifies when a spend pushes the day over budget (still logs
      // silently either way — this only controls the notification).
      smsNotifyMode: 'always',
      categories: [...DEFAULT_CATEGORIES],
      reminderMorningEnabled: false,
      reminderMorningTime: '08:00',
      reminderEveningEnabled: false,
      reminderEveningTime: '20:00',
      weeklySummaryEnabled: false,
    },
    day: { date: todayStr(), spends: [] },
    streak: { count: 0 },
    history: [],
    // Flat, capped log of every past (already-rolled-over) day's spends,
    // category intact — day.spends only holds *today's* still-editable
    // list, so category breakdowns need this to see further back.
    spendLog: [],
    goals: [],
    breaks: [],
    // M-Pesa transaction codes already recorded, native or manual dedup —
    // an SMS re-delivered by the OS (or re-drained after a crash) can never
    // be logged twice. Bounded so it can't grow forever.
    processedMpesaCodes: [],
    // Fuliza repayment/activation/interest events — tracked for visibility
    // only, never counted toward spentToday (repaying or being charged for
    // Fuliza isn't a new expense, it's clearing/servicing a past one).
    fulizaEvents: [],
  };
}

function load() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    return {
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings || {}) },
      day: saved.day && saved.day.date ? saved.day : base.day,
      streak: { ...base.streak, ...(saved.streak || {}) },
      history: Array.isArray(saved.history) ? saved.history : [],
      spendLog: Array.isArray(saved.spendLog) ? saved.spendLog : [],
      goals: Array.isArray(saved.goals) ? saved.goals : [],
      breaks: Array.isArray(saved.breaks) ? saved.breaks : [],
      processedMpesaCodes: Array.isArray(saved.processedMpesaCodes) ? saved.processedMpesaCodes : [],
      fulizaEvents: Array.isArray(saved.fulizaEvents) ? saved.fulizaEvents : [],
    };
  } catch {
    return base;
  }
}

export function registerStore(Alpine) {
  Alpine.store('sl', {
    ...load(),

    init() {
      this.rollover();
      this.scheduleMidnight();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.rollover();
      });
    },

    persist() {
      const { version, settings, day, streak, history, spendLog, goals, breaks, processedMpesaCodes, fulizaEvents } = this;
      localStorage.setItem(
        KEY,
        JSON.stringify({ version, settings, day, streak, history, spendLog, goals, breaks, processedMpesaCodes, fulizaEvents })
      );
      window.dispatchEvent(new CustomEvent('savelock:persist'));
    },

    // ---- day boundary -------------------------------------------------

    scheduleMidnight() {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
      setTimeout(() => {
        this.rollover();
        this.scheduleMidnight();
      }, next - now);
    },

    // Close out every day that has passed since the app last ran.
    // A closed day at or under the limit extends the streak; over it, the
    // streak resets. Days are only judged once a daily limit exists.
    rollover() {
      const today = todayStr();
      if (this.day.date === today) return;
      if (this.day.date > today) {
        // Device clock moved backwards; adopt today without judging anything.
        this.day = { date: today, spends: [] };
        this.persist();
        return;
      }
      let date = this.day.date;
      let spends = this.day.spends;
      while (date < today) {
        const limit = this.settings.dailyLimit;
        if (spends.length) {
          this.spendLog.push(...spends);
        }
        if (limit > 0) {
          const spent = spends.reduce((s, x) => s + x.amount, 0);
          this.streak.count = spent <= limit ? this.streak.count + 1 : 0;
          this.history.push({ date, limit, spent });
          if (this.history.length > HISTORY_CAP) {
            this.history = this.history.slice(-HISTORY_CAP);
          }
        }
        date = addDays(date, 1);
        spends = [];
      }
      if (this.spendLog.length > SPEND_LOG_CAP) {
        this.spendLog = this.spendLog.slice(-SPEND_LOG_CAP);
      }
      this.day = { date: today, spends: [] };
      this.persist();
    },

    // ---- daily allowance ----------------------------------------------

    get hasLimit() {
      return this.settings.dailyLimit > 0;
    },

    get spentToday() {
      return this.day.spends.reduce((s, x) => s + x.amount, 0);
    },

    get remaining() {
      return Math.round((this.settings.dailyLimit - this.spentToday) * 100) / 100;
    },

    get remainingRatio() {
      if (!this.hasLimit) return 0;
      return Math.max(0, Math.min(1, this.remaining / this.settings.dailyLimit));
    },

    // Last 7 days (including today) for the little history chart.
    get last7() {
      const today = todayStr();
      const byDate = Object.fromEntries(this.history.map((h) => [h.date, h]));
      const out = [];
      for (let i = 6; i >= 0; i--) {
        const date = addDays(today, -i);
        const isToday = date === today;
        const h = byDate[date];
        out.push({
          label: toDate(date).toLocaleDateString('en-GB', { weekday: 'narrow' }),
          spent: isToday ? this.spentToday : h ? h.spent : 0,
          limit: isToday ? this.settings.dailyLimit : h ? h.limit : this.settings.dailyLimit,
          today: isToday,
        });
      }
      return out;
    },

    setLimit(v) {
      this.settings.dailyLimit = v;
      this.persist();
    },

    setCurrency(label) {
      this.settings.currency = (label || 'KSh').trim().slice(0, 6);
      this.persist();
    },

    logSpend(amount, note = '', category = 'Other') {
      this.rollover();
      this.day.spends.push({ id: uid(), amount, note, category, at: Date.now() });
      this.persist();
    },

    deleteSpend(id) {
      this.day.spends = this.day.spends.filter((s) => s.id !== id);
      this.persist();
    },

    setSpendCategory(id, category) {
      const spend = this.day.spends.find((s) => s.id === id) || this.spendLog.find((s) => s.id === id);
      if (!spend) return;
      spend.category = category;
      this.persist();
    },

    setSmsNotifySpend(v) {
      this.settings.smsNotifySpend = !!v;
      this.persist();
    },

    setSmsNotifyReceived(v) {
      this.settings.smsNotifyReceived = !!v;
      this.persist();
    },

    setSmsNotifyMode(mode) {
      this.settings.smsNotifyMode = mode === 'importantOnly' ? 'importantOnly' : 'always';
      this.persist();
    },

    setReminderMorning(enabled, time) {
      this.settings.reminderMorningEnabled = !!enabled;
      if (time) this.settings.reminderMorningTime = time;
      this.persist();
    },

    setReminderEvening(enabled, time) {
      this.settings.reminderEveningEnabled = !!enabled;
      if (time) this.settings.reminderEveningTime = time;
      this.persist();
    },

    setWeeklySummary(enabled) {
      this.settings.weeklySummaryEnabled = !!enabled;
      this.persist();
    },

    // ---- categories -------------------------------------------------------

    addCategory(name) {
      const clean = (name || '').trim().slice(0, 24);
      if (!clean || this.settings.categories.includes(clean)) return;
      this.settings.categories.push(clean);
      this.persist();
    },

    renameCategory(oldName, newName) {
      const clean = (newName || '').trim().slice(0, 24);
      if (!clean || oldName === 'Other') return;
      const idx = this.settings.categories.indexOf(oldName);
      if (idx === -1 || this.settings.categories.includes(clean)) return;
      this.settings.categories[idx] = clean;
      for (const s of [...this.day.spends, ...this.spendLog]) {
        if (s.category === oldName) s.category = clean;
      }
      this.persist();
    },

    // "Other" always exists as the fallback category and can't be removed.
    removeCategory(name) {
      if (name === 'Other') return;
      this.settings.categories = this.settings.categories.filter((c) => c !== name);
      for (const s of [...this.day.spends, ...this.spendLog]) {
        if (s.category === name) s.category = 'Other';
      }
      this.persist();
    },

    // Category totals over the trailing `days` window (today inclusive),
    // highest spend first.
    categoryBreakdown(days) {
      const cutoff = Date.now() - days * 86400000;
      const all = [...this.spendLog, ...this.day.spends].filter((s) => s.at >= cutoff);
      const totals = {};
      let grandTotal = 0;
      for (const s of all) {
        const cat = s.category || 'Other';
        totals[cat] = (totals[cat] || 0) + s.amount;
        grandTotal += s.amount;
      }
      return Object.entries(totals)
        .map(([category, total]) => ({
          category,
          total: Math.round(total * 100) / 100,
          pct: grandTotal > 0 ? total / grandTotal : 0,
        }))
        .sort((a, b) => b.total - a.total);
    },

    topCategories(days, n = 3) {
      return this.categoryBreakdown(days).slice(0, n);
    },

    // ---- SMS auto-detected transactions (native Android shell only) -----
    //
    // The native SmsReceiver parses+notifies+queues instantly, even while
    // this JS runtime isn't running. It hands transactions over here in two
    // ways: one at a time as they arrive while the app is open (native-bridge
    // listens for a plugin event), and in a batch on launch/resume to pick up
    // whatever queued while the app was fully closed. Both paths land here,
    // so the mpesaCode dedup guards against double-logging either way.

    recordNativeTransaction(tx) {
      if (!tx || !tx.mpesaCode || this.processedMpesaCodes.includes(tx.mpesaCode)) return null;
      this.processedMpesaCodes.push(tx.mpesaCode);
      if (this.processedMpesaCodes.length > 300) {
        this.processedMpesaCodes = this.processedMpesaCodes.slice(-300);
      }
      if (tx.type === 'fuliza_repayment' || tx.type === 'fuliza_activation' || tx.type === 'fuliza_interest') {
        // Fuliza clearing/servicing a past debt, not a new expense — tracked
        // for visibility only, never added to spentToday.
        this.fulizaEvents.push({
          id: uid(),
          type: tx.type,
          amount: Math.round(tx.amount * 100) / 100,
          at: tx.receivedAt || Date.now(),
          mpesaCode: tx.mpesaCode,
        });
        if (this.fulizaEvents.length > FULIZA_EVENTS_CAP) {
          this.fulizaEvents = this.fulizaEvents.slice(-FULIZA_EVENTS_CAP);
        }
        this.persist();
        return null;
      }
      if (tx.type !== 'spend') {
        // "received" — never counted as spending, just marked seen so a
        // redelivered SMS can't notify twice.
        this.persist();
        return null;
      }
      this.rollover();
      const amount = Math.round(tx.amount * 100) / 100;
      const record = {
        id: uid(),
        amount,
        note: tx.counterparty || '',
        category: tx.category || 'Other',
        at: tx.receivedAt || Date.now(),
        source: 'sms',
        mpesaCode: tx.mpesaCode,
        classification: 'spend',
        // Real spending, just covered by overdraft rather than balance —
        // kept for the "via Fuliza" badge, financial-awareness only.
        viaFuliza: !!tx.viaFuliza,
        fulizaAmount: tx.viaFuliza ? tx.fulizaAmount : null,
      };
      this.day.spends.push(record);
      this.persist();
      return record;
    },

    drainNativeTransactions(list) {
      return (Array.isArray(list) ? list : []).map((tx) => this.recordNativeTransaction(tx)).filter(Boolean);
    },

    // "Not spending" — e.g. an SMS-detected transfer that was really money
    // moved into a real-world lock. Pulls the amount back out of today's
    // spending and credits it to the goal's saved total. No money moves;
    // this only corrects the score.
    reclassifyAsSavings(spendId, goalId) {
      const idx = this.day.spends.findIndex((s) => s.id === spendId);
      if (idx === -1) return null;
      const goal = this.goals.find((g) => g.id === goalId && g.status === 'active');
      if (!goal) return null;
      const [spend] = this.day.spends.splice(idx, 1);
      spend.classification = 'savings-transfer';
      const milestones = this.creditGoal(goal, spend.amount);
      this.persist();
      return { spend, goal, milestones };
    },

    // ---- goals ----------------------------------------------------------

    get activeGoals() {
      return this.goals.filter((g) => g.status === 'active');
    },

    get pastGoals() {
      return this.goals
        .filter((g) => g.status !== 'active')
        .slice()
        .reverse();
    },

    addGoal(name, target, date) {
      this.goals.push({
        id: uid(),
        name,
        target,
        saved: 0,
        date,
        createdAt: todayStr(),
        status: 'active',
        milestonesHit: [],
        savedHistory: [{ at: new Date().toISOString(), amount: 0 }],
      });
      this.persist();
    },

    // Adds `amount` to a goal's saved total and returns any milestone
    // thresholds (25/50/75/100) newly crossed by this change, so the UI can
    // show a one-off celebration rather than just a number changing.
    creditGoal(goal, amount) {
      goal.saved = Math.round((goal.saved + amount) * 100) / 100;
      return this.recordSavedProgress(goal);
    },

    recordSavedProgress(goal) {
      if (!Array.isArray(goal.milestonesHit)) goal.milestonesHit = [];
      if (!Array.isArray(goal.savedHistory)) goal.savedHistory = [];
      goal.savedHistory.push({ at: new Date().toISOString(), amount: goal.saved });
      if (goal.savedHistory.length > 200) goal.savedHistory = goal.savedHistory.slice(-200);
      const pct = this.progress(goal) * 100;
      const newly = MILESTONES.filter((m) => pct >= m && !goal.milestonesHit.includes(m));
      goal.milestonesHit.push(...newly);
      return newly;
    },

    // Sets the saved total directly (the user telling us what's actually in
    // the real lock right now) rather than adding an increment.
    updateSaved(id, amount) {
      const g = this.goals.find((x) => x.id === id);
      if (!g) return [];
      g.saved = amount;
      const milestones = this.recordSavedProgress(g);
      this.persist();
      return milestones;
    },

    // Average KSh/day saved over the trailing 30 days of this goal's
    // history (or its whole history if younger). Null when there isn't
    // enough of a track record yet to mean anything.
    pace(g) {
      const history = Array.isArray(g.savedHistory) ? g.savedHistory : [];
      if (history.length < 2) return null;
      const cutoff = Date.now() - 30 * 86400000;
      const windowed = history.filter((h) => new Date(h.at).getTime() >= cutoff);
      const points = windowed.length >= 2 ? windowed : history;
      const first = points[0];
      const last = points[points.length - 1];
      const days = (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86400000;
      if (days <= 0) return null;
      return (last.amount - first.amount) / days;
    },

    // Rough "at this rate" finish date, or null if there's no positive pace
    // to project from yet.
    projectedFinishDate(g) {
      if (this.reached(g)) return todayStr();
      const remaining = g.target - g.saved;
      if (remaining <= 0) return todayStr();
      const p = this.pace(g);
      if (!p || p <= 0) return null;
      return addDays(todayStr(), Math.ceil(remaining / p));
    },

    daysLeft(g) {
      return Math.max(0, daysBetween(todayStr(), g.date));
    },

    progress(g) {
      if (!g.target) return 0;
      return Math.max(0, Math.min(1, g.saved / g.target));
    },

    reached(g) {
      return g.saved >= g.target;
    },

    matured(g) {
      return todayStr() >= g.date;
    },

    completeGoal(id) {
      const g = this.goals.find((x) => x.id === id);
      if (!g) return;
      g.status = 'done';
      g.completedAt = todayStr();
      this.persist();
    },

    // Breaking a lock never moves money. It records the break and resets
    // the daily-budget streak — that loss is the point.
    breakGoal(id) {
      const g = this.goals.find((x) => x.id === id);
      if (!g || g.status !== 'active') return;
      const record = {
        goalId: g.id,
        goalName: g.name,
        at: new Date().toISOString(),
        daysEarly: this.daysLeft(g),
        saved: g.saved,
        target: g.target,
        streakLost: this.streak.count,
      };
      g.status = 'broken';
      g.brokenAt = todayStr();
      g.daysEarly = record.daysEarly;
      g.streakLost = record.streakLost;
      this.breaks.push(record);
      this.streak.count = 0;
      this.persist();
    },

    // ---- backup ---------------------------------------------------------

    exportData() {
      const { version, settings, day, streak, history, spendLog, goals, breaks, processedMpesaCodes, fulizaEvents } = this;
      return JSON.stringify(
        {
          app: 'savelock',
          version,
          exportedAt: new Date().toISOString(),
          data: { version, settings, day, streak, history, spendLog, goals, breaks, processedMpesaCodes, fulizaEvents },
        },
        null,
        2
      );
    },

    importData(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return 'That file is not valid JSON.';
      }
      const data = parsed && parsed.app === 'savelock' ? parsed.data : parsed;
      if (
        !data ||
        typeof data !== 'object' ||
        !data.settings ||
        !data.day ||
        !Array.isArray(data.goals)
      ) {
        return 'That file does not look like a SaveLock backup.';
      }
      localStorage.setItem(KEY, JSON.stringify({ ...defaultState(), ...data }));
      return null;
    },

    eraseAll() {
      localStorage.removeItem(KEY);
      Object.assign(this, defaultState());
      this.persist();
    },

    // ---- formatting -------------------------------------------------------

    fmt(n) {
      return (n ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
    },

    money(n) {
      return `${this.settings.currency} ${this.fmt(n)}`;
    },

    dateLong(s = todayStr()) {
      return toDate(s).toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
    },

    dateShort(s) {
      if (!s) return '';
      return toDate(s).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    },

    time(ms) {
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
  });
}
