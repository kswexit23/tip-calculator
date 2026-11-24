'use strict';
/*
 * 팁 계산 순수 로직 (UI와 분리, 단위 테스트 대상)
 * 금액은 전부 센트(정수)로 계산해서 반올림 오차를 없앤다.
 *
 * 규칙 (2026-11-22 사용자 확정, v6에서 시간/구간 방식 폐기 → 선지급 방식,
 *       v7에서 계산 순서 정정 — 주방 10%는 선지급에서도 먼저 간다,
 *       v13에서 주방 몫 달러 단위 버림 추가 — 2026-11-24 사용자 지시):
 * 시프트별 계산 순서:
 * 1. (선택) 선지급: 지정한 사람에게 지정한 금액을 먼저 떼어주되, 주방이 있으면
 *    그 금액의 10%는 주방 몫으로 가고 받는 사람은 90%를 가진다.
 *    여러 명 지정 가능. 선지급 합계가 총액 이상이면 검증 오류.
 * 2. 나머지(총액 − 선지급 합계)에서도 주방 몫 KITCHEN_RATE(10%)를 뗀다
 *    (주방이 선택된 경우만). 즉 주방 풀은 언제나 팁 전체의 10%와 같다.
 *    주방이 없으면 10% 단계 자체가 없다.
 * 2-1. (v13) 주방 풀은 달러 단위로 버린다(floor). 버려진 센트 잔돈은
 *    3의 서버 균등 분배 풀에 더한다 (잔돈은 팁으로 지급하기 어려움).
 *    버림된 주방 몫을 주방 근무자끼리 균등 분배한다.
 * 3. 나머지를 그 시프트에서 일한 서버 전원이 균등 분배한다.
 *    선지급 받은 사람도 균등 분배에는 그대로 참여한다.
 * 하루 합산은 computeDay. 균등 분배의 1센트 나머지는 앞에서부터 1센트씩
 * 배분해 합계를 정확히 맞춘다.
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

  /*
   * 시프트 1개 계산.
   * input: {
   *   totalCents: number,
   *   kitchenIds: [id],   // 선택된 주방 사람들
   *   serverIds: [id],    // 선택된 서버 사람들
   *   prepays: [{personId, amountCents}],  // 선지급 (먼저 떼어줄 금액)
   * }
   * 반환: {perPerson, perPersonDetail, kitchenTotalCents,
   *        kitchenRawCents, kitchenLeftoverCents,
   *        kitchenFromPrepayCents, poolCents, prepayTotalCents, warnings,
   *        incomplete, totalCents, distributedCents, balanced}
   * - kitchenTotalCents는 v13부터 실제로 주방이 가져가는 총액(달러 버림 후).
   *   버림 전 10% 원액은 kitchenRawCents, 서버 풀로 넘어간 잔돈은
   *   kitchenLeftoverCents에 담는다.
   * - perPersonDetail[id] = {prepayCents(순액), kitchenCents, serverCents}
   *   로 구성 요소를 나눠 알려준다 (완료 요약 표시용).
   * - 검증 오류(선지급 합계 >= 총액, 선지급 음수, 서버 미선택)면 incomplete=true,
   *   아무것도 배분하지 않는다 (perPerson 비어 있음, balanced=false).
   */
  function computeShift(input) {
    const totalCents = Math.round(input.totalCents || 0);
    const kitchenIds = input.kitchenIds || [];
    const serverIds = input.serverIds || [];
    const prepays = (input.prepays || []).map(p => ({
      personId: p.personId,
      amountCents: Math.round(p.amountCents || 0),
    }));
    const warnings = [];
    const perPerson = {};
    const perPersonDetail = {};
    const hasKitchen = kitchenIds.length > 0;

    function addPart(id, kind, cents) {
      perPerson[id] = (perPerson[id] || 0) + cents;
      if (!perPersonDetail[id]) {
        perPersonDetail[id] = { prepayCents: 0, kitchenCents: 0, serverCents: 0 };
      }
      perPersonDetail[id][kind] += cents;
    }

    if (totalCents < 0) warnings.push('팁 총액이 0보다 작아요.');

    const prepayTotal = prepays.reduce((a, p) => a + p.amountCents, 0);
    let invalid = totalCents < 0;
    if (prepays.some(p => p.amountCents < 0)) {
      warnings.push('먼저 떼어줄 금액이 0보다 작아요. 금액을 확인해 주세요.');
      invalid = true;
    }
    if (prepayTotal > 0 && prepayTotal >= totalCents) {
      warnings.push('먼저 떼어줄 금액의 합계가 팁 총액과 같거나 많아요. 금액을 확인해 주세요.');
      invalid = true;
    }
    if (totalCents > 0 && serverIds.length === 0) {
      warnings.push('일한 서버를 선택해 주세요.');
      invalid = true;
    }
    const incomplete = invalid;

    let kitchenRaw = 0;
    let kitchenPaid = 0;
    let kitchenLeftover = 0;
    let kitchenFromPrepay = 0;
    let pool = 0;
    if (!incomplete) {
      // 1) 선지급: 주방이 있으면 각 금액의 10%는 주방 몫, 받는 사람은 90%.
      prepays.forEach(p => {
        const cut = hasKitchen ? Math.round(p.amountCents * CONFIG.KITCHEN_RATE) : 0;
        kitchenFromPrepay += cut;
        addPart(p.personId, 'prepayCents', p.amountCents - cut);
      });
      const rest = totalCents - prepayTotal;
      // 2) 나머지에서도 주방 10% (주방이 있을 때만)
      let kitchenFromRest = 0;
      if (hasKitchen && rest > 0) {
        kitchenFromRest = Math.round(rest * CONFIG.KITCHEN_RATE);
      }
      kitchenRaw = kitchenFromPrepay + kitchenFromRest;
      // 2-1) v13: 주방 풀을 달러 단위로 버리고, 센트 잔돈은 서버 풀로 넘긴다.
      kitchenPaid = kitchenRaw;
      if (hasKitchen && kitchenRaw > 0) {
        kitchenPaid = Math.floor(kitchenRaw / 100) * 100;
        kitchenLeftover = kitchenRaw - kitchenPaid;
      }
      if (hasKitchen && kitchenPaid > 0) {
        const shares = splitCents(kitchenPaid, kitchenIds.length);
        kitchenIds.forEach((id, i) => {
          addPart(id, 'kitchenCents', shares[i]);
        });
      }
      // 3) 서버 전원 균등 분배 (선지급 받은 사람도 참여).
      //    풀에는 주방에서 넘어온 센트 잔돈(kitchenLeftover)이 더해진다.
      pool = rest - kitchenFromRest + kitchenLeftover;
      if (serverIds.length > 0) {
        const shares = splitCents(pool, serverIds.length);
        serverIds.forEach((id, i) => {
          addPart(id, 'serverCents', shares[i]);
        });
      }
    }

    const distributed = Object.values(perPerson).reduce((a, b) => a + b, 0);
    return {
      perPerson,
      perPersonDetail,
      kitchenTotalCents: kitchenPaid,
      kitchenRawCents: kitchenRaw,
      kitchenLeftoverCents: kitchenLeftover,
      kitchenFromPrepayCents: kitchenFromPrepay,
      poolCents: pool,
      prepayTotalCents: prepayTotal,
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

  return { CONFIG, toCents, splitCents, computeShift, computeDay };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TipCalc;
if (typeof window !== 'undefined') window.TipCalc = TipCalc;
