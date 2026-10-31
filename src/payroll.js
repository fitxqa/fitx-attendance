// Payroll maths (pure functions, no Firebase) — monthly salary, overtime, late and absence deductions.
import * as T from './time.js';

export const PAY_DEFAULT = {
  dutyHours: 12,        // normal duty hours per day; time beyond this is overtime
  workDays: 26,         // salary ÷ (workDays × dutyHours) = hourly rate
  otRate: 1.25,         // overtime pay = hourly rate × this
  lateMode: 'minute',   // 'minute' = deduct each late minute at the hourly rate · 'fixed' = fixed amount per late day
  lateFixed: 25,        // QR per late day when lateMode = 'fixed'
  absence: 100,         // QR deducted per absent work day
  offDays: [5],         // weekly days off (0 = Sun … 5 = Fri, 6 = Sat) — never counted as absent
  currency: 'QR',
};

const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : 0);
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One employee, one month.
// days: { yyyymmdd: { amIn, amOut, pmIn, pmOut } } · salary: monthly QR · adj: { excused, bonus, deduct }
// office: shift times (amIn, grace) · today: current work date (days from today on are not judged absent)
// since: first work date to judge (e.g. employee's start date), optional
export function payFor({ month, days = {}, salary = 0, adj = {}, settings = {}, office = {}, today, since = 0 }) {
  const S = { ...PAY_DEFAULT, ...settings };
  const dutyMin = (Number(S.dutyHours) || 12) * 60;
  const hourly = salary > 0 ? salary / ((Number(S.workDays) || 26) * (Number(S.dutyHours) || 12)) : 0;
  const grace = Number(office.grace) || 0;
  const sched = T.schedMin(office.amIn || '09:00');

  let worked = 0, dutyTotal = 0, otMin = 0, lateMin = 0, lateDays = 0, openDays = 0;
  const perDay = [];
  for (const [k, p] of Object.entries(days)) {
    const di = Number(k);
    const first = p.amIn || p.pmIn;
    if (!first) continue;
    worked++;
    let duty = 0, ot = 0, late = 0;
    if (p.pmOut) {
      duty = Math.max(0, (ms(p.pmOut.t) - ms(first.t)) / 60000);
      ot = Math.max(0, duty - dutyMin);
    } else if (di < today) openDays++; // never checked out → no overtime for that day
    if (p.amIn) {
      const m = T.workMin(ms(p.amIn.t)) - sched;
      if (m > grace) { late = m; lateDays++; }
    }
    dutyTotal += duty; otMin += ot; lateMin += late;
    perDay.push({ date: di, duty, ot, late });
  }

  // Absent = past work days in the month (not a weekly day off) with no punch at all.
  const offDays = (S.offDays || []).map(Number);
  let workDaysSoFar = 0, absent = 0;
  const dim = T.daysInMonth(month);
  for (let d = 1; d <= dim; d++) {
    const di = month * 100 + d;
    if (di >= today || (since && di < since)) continue;
    if (offDays.includes(T.dow(di))) continue;
    workDaysSoFar++;
    const p = days[di];
    if (!p || !(p.amIn || p.pmIn)) absent++;
  }
  const excused = Math.min(absent, Math.max(0, Number(adj.excused) || 0));
  const chargedAbsent = absent - excused;

  const otPay = round2((otMin / 60) * hourly * (Number(S.otRate) || 1));
  const lateDeduct = round2(S.lateMode === 'fixed' ? lateDays * (Number(S.lateFixed) || 0) : (lateMin / 60) * hourly);
  const absenceDeduct = round2(chargedAbsent * (Number(S.absence) || 0));
  const bonus = round2(adj.bonus), other = round2(adj.deduct);
  const net = round2((Number(salary) || 0) + otPay - lateDeduct - absenceDeduct + bonus - other);

  return {
    salary: round2(salary), hourly: round2(hourly), worked, workDaysSoFar, absent, excused, chargedAbsent,
    dutyMin: Math.round(dutyTotal), otMin: Math.round(otMin), lateMin: Math.round(lateMin), lateDays, openDays,
    otPay, lateDeduct, absenceDeduct, bonus, other, net, perDay,
  };
}
