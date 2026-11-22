'use strict';
/*
 * 팁 계산 순수 로직 (UI와 분리, 단위 테스트 대상)
 * 금액은 전부 센트(정수)로 계산해서 반올림 오차를 없앤다.
 *
 * 규칙 (2026-11-22 사용자 확정):
 * 1. 시프트별 따로 계산, 하루 합산은 computeDay.
 * 2. 주방이 선택된 시프트는 팁 총액의 KITCHEN_RATE(10%)를 주방 몫으로 먼저 뗀다.
 *    주방이 여럿이면 그 10%를 균등 분배. 나머지가 서버 풀.
 * 3. 구간 분배는 시간 비례 금지 — 실제 체크 금액 기준.
 *    모든 서버의 시간 경계로 구간(segment)을 나누고, 구간마다 실제 팁 합계를 입력받는다.
 *    마지막 구간은 "나머지 자동". 각 구간 금액은 그 구간 서버끼리 균등 분배.
 * 4. 균등 분배의 1센트 나머지는 앞에서부터 1센트씩 배분해 합계를 정확히 맞춘다.
 */
const TipCalc = (() => {
  const CONFIG = {
    KITCHEN_RATE: 0.10, // 주방 몫 비율 — 바꾸려면 여기 한 곳만 수정
  };

  function toCents(v) {
    const n = typeof v === 'string' ? parseFloat(v) : Number(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  // totalCents를 n명에게 균등 분배. 나머지는 앞에서부터 1센트씩. 합계는 항상 totalCents와 일치.
  function splitCents(totalCents, n) {
    if (n <= 0) return [];
    const sign = totalCents < 0 ? -1 : 1;
    const t = Math.abs(Math.round(totalCents));
    const base = Math.floor(t / n);
    let rem = t - base * n;
    const out = [];
    for (let i = 0; i < n; i++) {
      let v = base;
      if (rem > 0) { v += 1; rem -= 1; }
      out.push(sign * v);
    }
    return out;
  }

  // 'HH:MM' -> 자정부터 분. 형식이 아니면 null.
  function timeToMin(t) {
    if (!t || typeof t !== 'string') return null;
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  /*
   * 서버들의 근무 시간으로 시프트를 구간으로 나눈다.
   * workers: [{id, startMin|null, endMin|null}] — null이면 시프트 전체 근무로 본다.
   * 반환: [{startMin, endMin, memberIds}] — 서버가 1명 이상 있는 구간만, 시간순.
   */
  function buildSegments(shiftStartMin, shiftEndMin, workers) {
    if (shiftStartMin == null || shiftEndMin == null || shiftEndMin <= shiftStartMin) return [];
    const spans = (workers || [])
      .map(w => ({
        id: w.id,
        s: w.startMin == null ? shiftStartMin : w.startMin,
        e: w.endMin == null ? shiftEndMin : w.endMin,
      }))
      .filter(w => w.e > w.s);
    const points = new Set([shiftStartMin, shiftEndMin]);
    spans.forEach(w => { points.add(w.s); points.add(w.e); });
    const sorted = [...points]
      .filter(p => p >= shiftStartMin && p <= shiftEndMin)
      .sort((a, b) => a - b);
    const segs = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const s = sorted[i];
      const e = sorted[i + 1];
      if (e <= s) continue;
      const members = spans.filter(w => w.s <= s && w.e >= e).map(w => w.id);
      if (members.length === 0) continue;
      segs.push({ startMin: s, endMin: e, memberIds: members });
    }
    return segs;
  }

  /*
   * 시프트 1개 계산.
   * input: {
   *   totalCents: number,
   *   kitchenIds: [id],                                   // 선택된 주방 사람들
   *   segments: [{memberIds: [id], amountCents: number|null}]  // buildSegments 결과 + 구간 팁
   * }
   * - 구간이 1개면 그 구간 금액 = 서버 풀 전체 (입력 불필요).
   * - 구간이 여러 개면 마지막 구간은 자동(풀 - 나머지 합), 나머지는 amountCents 필수.
   * 반환: {perPerson, kitchenTotalCents, poolCents, segments(금액 확정본), warnings,
   *        incomplete, totalCents, distributedCents, balanced}
   */
  function computeShift(input) {
    const totalCents = Math.round(input.totalCents || 0);
    const kitchenIds = input.kitchenIds || [];
    const segments = input.segments || [];
    const warnings = [];
    const perPerson = {};

    if (totalCents < 0) warnings.push('팁 총액이 0보다 작아요.');

    let kitchenTotal = 0;
    if (kitchenIds.length > 0 && totalCents > 0) {
      kitchenTotal = Math.round(totalCents * CONFIG.KITCHEN_RATE);
      const shares = splitCents(kitchenTotal, kitchenIds.length);
      kitchenIds.forEach((id, i) => {
        perPerson[id] = (perPerson[id] || 0) + shares[i];
      });
    }
    const pool = totalCents - kitchenTotal;

    const resolved = segments.map(s => ({
      startMin: s.startMin,
      endMin: s.endMin,
      memberIds: s.memberIds.slice(),
      amountCents: s.amountCents == null ? null : Math.round(s.amountCents),
      auto: false,
    }));

    let incomplete = false;
    if (totalCents > 0 && resolved.length === 0) {
      warnings.push('일한 서버를 선택해 주세요.');
      incomplete = true;
    } else if (resolved.length === 1) {
      resolved[0].amountCents = pool;
      resolved[0].auto = true;
    } else if (resolved.length > 1) {
      let known = 0;
      resolved.forEach((s, i) => {
        if (i < resolved.length - 1) {
          if (s.amountCents == null) incomplete = true;
          else known += s.amountCents;
        }
      });
      const last = resolved[resolved.length - 1];
      last.amountCents = pool - known;
      last.auto = true;
      if (last.amountCents < 0) {
        warnings.push('구간 팁 합계가 전체 팁보다 많아요. 금액을 확인해 주세요.');
      }
    }
    if (incomplete && !warnings.some(w => w.indexOf('구간') === 0)) {
      warnings.push('구간 팁 금액을 모두 입력해 주세요.');
    }

    if (!incomplete) {
      resolved.forEach(s => {
        if (s.amountCents == null || s.memberIds.length === 0) return;
        const shares = splitCents(s.amountCents, s.memberIds.length);
        s.memberIds.forEach((id, i) => {
          perPerson[id] = (perPerson[id] || 0) + shares[i];
        });
      });
    }

    const distributed = Object.values(perPerson).reduce((a, b) => a + b, 0);
    return {
      perPerson,
      kitchenTotalCents: kitchenTotal,
      poolCents: pool,
      segments: resolved,
      warnings,
      incomplete,
      totalCents,
      distributedCents: distributed,
      balanced: !incomplete && distributed === totalCents,
    };
  }

  // 하루 합산: 시프트 결과들을 사람별로 합친다.
  function computeDay(shiftResults) {
    const perPerson = {};
    let total = 0;
    let distributed = 0;
    let balanced = true;
    (shiftResults || []).forEach(r => {
      total += r.totalCents;
      distributed += r.distributedCents;
      if (!r.balanced) balanced = false;
      Object.entries(r.perPerson).forEach(([id, c]) => {
        perPerson[id] = (perPerson[id] || 0) + c;
      });
    });
    return {
      perPerson,
      totalCents: total,
      distributedCents: distributed,
      balanced: balanced && total === distributed,
    };
  }

  return { CONFIG, toCents, splitCents, timeToMin, buildSegments, computeShift, computeDay };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TipCalc;
if (typeof window !== 'undefined') window.TipCalc = TipCalc;
