'use strict';
/*
 * 팁톡(TipTalk) UI (v7)
 * 기본 흐름: 일한 사람 칩 선택 → 팁 총액 입력(또는 사진) → 결과 확인
 * v6: 시간/구간 방식 폐기 → "선지급" 방식. 접힌 옵션에서 먼저 온 사람에게
 *     먼저 떼어줄 금액을 지정하면, 총액에서 그만큼을 먼저 주고 → 나머지를
 *     서버 전원이 균등 분배한다 (calc.js 참고).
 *     카드 내부 순서도 칩 → 사진 → 총액 → 선지급 옵션으로 재배열.
 * v7: 계산 순서 정정 — 주방 10%는 선지급에서도 먼저 간다 (주방 총액 = 전체의 10%).
 *     시프트 카드에 "완료" 버튼 추가: 누르면 입력이 접히고 요약이 남는다.
 *     맨 아래 주급 정산표를 날짜별 기록 달력으로 교체하고, 선택 날짜부터
 *     2주 기간의 "팁 지급하기"(내역 화면 + CSV 다운로드 + 텍스트 복사)를 붙였다.
 * v8: 날짜/요일 전수 감사 — 날짜 문자열은 전부 로컬 파싱(parseDateStr)만 쓴다.
 *     'YYYY-MM-DD'를 new Date(str)로 파싱하면 UTC 자정으로 해석돼 UTC-10(HST)
 *     에서 하루 밀리므로 절대 금지. 렌더 테스트에 HST 회귀 검사가 있다.
 *     직원 명단 카드는 index.html에서 페이지 맨 아래로 이동했다.
 * v9: "사진 지우기" — 잘못 올린 사진을 지운다. 사진이 채운 값(총액·이름 제안·
 *     참고 정보)만 되돌리고 손으로 고친 값은 그대로 둔다. 판독 중이면 폴링을
 *     멈추고 늦은 결과는 버리며, 백엔드 행 취소·파일 삭제는 best-effort로 건다
 *     (정책 SQL은 add-v9-photo-delete.sql, 없어도 UI는 동작).
 * v12: 완료 버튼 위 안내 — 총액이 없어서 완료 버튼이 비활성인 경우 버튼 바로
 *     위에 "팁 총액을 입력하면 완료할 수 있어요"를 표시한다. 총액 미입력
 *     상태에서는 "선지급 합계 >= 총액" 경고를 표시에서 빼 안내와 겹치지
 *     않게 한다 (계산·경고 생성은 그대로). 선지급 행에는 삭제 옆에
 *     확인/수정 버튼이 생겼다: 확인하면 그 행의 이름·금액 입력이 잠기고
 *     수정으로 풀 수 있다. 잠금은 세션 내 UI 상태일 뿐 계산·done 저장과
 *     무관하고, 새로고침하면 풀린다 (loadState 정규화가 행을
 *     {personId, amount}로 재구성하기 때문).
 * v11: 날짜 정정 — 입력(팁 금액)이 있는 상태에서 상단 날짜 칸을 바꾸면 입력이
 *     지워지지 않고 새 날짜로 따라가며, 옛 날짜에 저장된 이 입력의 기록도
 *     새 날짜로 옮겨진다. 새 날짜에 다른 기록이 있으면 인라인 확인 바에서
 *     확인받기 전까지 날짜를 원래대로 되돌려 둔다. 입력이 없으면 기존
 *     둘러보기 동작(입력 비움, 기록 무변경) 그대로다. 달력 날짜 클릭은
 *     둘러보기 용도라 기존 동작을 유지한다. 사진 참고 정보에 정산지 날짜를
 *     명시하고, 판독 실패 시에는 날짜 칸을 강조하며 직접 입력을 안내한다.
 * v3: 시프트 카드의 "사진으로 채우기" — 정산지 사진을 올리면 판독 데몬이 읽어서
 *     팁 총액을 자동 입력하고, 손글씨 이름은 명단과 매칭해 "제안" 칩으로만 표시한다
 *     (확정은 사용자가 탭해야 한다). 사진 통신은 js/photo.js (TipPhoto)가 담당.
 * v4: 날짜별 인당 합계 자동 저장(localStorage 'tiptalk_history_v1') +
 *     맨 아래 날짜별 기록 표시 (v7에서 달력으로 교체).
 *     사진 판독 성공 시 정산지 날짜로 날짜 선택이 자동 변경된다.
 *     날짜를 바꾸면 입력 총액은 비워진다(명단 선택은 유지) — 엉뚱한 날짜에
 *     이전 날짜 결과가 덮어씌워지는 사고를 막기 위한 안전장치.
 * 상태는 localStorage에 저장 (명단 + 마지막 선택 + 입력값).
 * 계산은 전부 js/calc.js 의 순수 함수에 위임한다.
 */
(function () {
  var LS_KEY = 'tipcalc-v1';
  var LS_HISTORY_KEY = 'tiptalk_history_v1';
  // 기본 명단 (버전 관리). 새 직원이 기본 명단에 추가되면 버전을 올린다.
  // 로드 시 저장된 명단에 없는 기본 인원은 병합으로 추가된다 (mergeDefaultRoster 참고).
  var DEFAULT_ROSTER_VERSION = 2;
  // aliases: 한 사람의 다른 표기(한글/영어)를 묶는 별칭 목록.
  // 확정 쌍: Young=영, Micky=미키. 나머지는 확정 전이라 비워 둔다 (임의로 만들지 않음).
  // 용도: 나중에 정산지 사진 판독의 손글씨 이름을 명단과 매칭할 때 사용.
  var DEFAULT_ROSTER = [
    { id: 'p-jiseon', name: '지선', role: 'server', aliases: [] },
    { id: 'p-sky', name: 'Sky', role: 'server', aliases: [] },
    { id: 'p-mew', name: 'Mew', role: 'server', aliases: [] },
    { id: 'p-young', name: 'Young', role: 'kitchen', aliases: ['영'] },
    { id: 'p-youngshin', name: 'Young shin', role: 'kitchen', aliases: [] },
    { id: 'p-nara', name: 'Nara', role: 'kitchen', aliases: [] },
    { id: 'p-micky', name: 'Micky', role: 'kitchen', aliases: ['미키'] },
  ];
  var SHIFT_DEFS = [
    { key: 'am', title: '오전 시프트 (점심)', defStart: '11:00', defEnd: '15:00' },
    { key: 'pm', title: '오후 시프트 (저녁)', defStart: '16:00', defEnd: '21:00' },
  ];

  // ---------- 상태 ----------
  function todayStr() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }
  function uid() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function freshShift(start, end) {
    return {
      total: '', start: start, end: end, selected: {}, prepays: [], advancedOpen: false,
      done: false,     // v7: "완료"를 누르면 입력이 접히고 요약만 남는다
      suggested: {},   // 사진 판독이 제안한 사람 {personId: 읽은 이름} — 확정은 사용자가 탭
      photoInfo: null, // 마지막 사진 판독 참고 정보 {purchase, tickets, time, fromOther, unmatched}
      photoRef: null,  // v9: 지금 붙어 있는 사진 {id, path, totalValue, suggestedIds}
                       // — 사진 지우기에서 "사진이 채운 값"을 판정하는 근거
    };
  }
  function seedState() {
    return {
      date: todayStr(),
      rosterVersion: DEFAULT_ROSTER_VERSION,
      roster: DEFAULT_ROSTER.map(function (p) {
        return { id: p.id, name: p.name, role: p.role, aliases: (p.aliases || []).slice() };
      }),
      shifts: {
        am: freshShift('11:00', '15:00'),
        pm: freshShift('16:00', '21:00'),
      },
    };
  }
  // 저장된 인원이 기본 인원과 같은 사람인지 판정 (id / 이름 / 별칭 교차 매칭).
  function samePerson(p, def) {
    if (p.id === def.id || p.name === def.name) return true;
    var pAliases = p.aliases || [];
    var dAliases = def.aliases || [];
    if (dAliases.indexOf(p.name) >= 0) return true;
    if (pAliases.indexOf(def.name) >= 0) return true;
    return dAliases.some(function (a) { return pAliases.indexOf(a) >= 0; });
  }
  // 기본 명단 병합: 저장된 명단에 없는 기본 인원을 뒤에 추가한다.
  // - 사용자가 직접 추가한 사람은 그대로 유지된다.
  // - 이미 있는 기본 인원은 기본 별칭이 빠져 있으면 채워 넣는다 (합집합).
  // - 사용자가 지운 기본 인원도 다시 추가된다 (뼈대 단계의 단순 동작 — SPEC 명시).
  // - 병합된 인원은 어떤 시프트에도 자동 선택되지 않는다 (선택은 shifts를 건드리지 않음).
  function mergeDefaultRoster(roster) {
    var merged = roster.slice();
    DEFAULT_ROSTER.forEach(function (def) {
      var found = null;
      merged.forEach(function (p) { if (!found && samePerson(p, def)) found = p; });
      if (found) {
        if (!Array.isArray(found.aliases)) found.aliases = [];
        (def.aliases || []).forEach(function (a) {
          if (found.aliases.indexOf(a) < 0) found.aliases.push(a);
        });
      } else {
        merged.push({ id: def.id, name: def.name, role: def.role, aliases: (def.aliases || []).slice() });
      }
    });
    return merged;
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return seedState();
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.roster) || !s.shifts || !s.shifts.am || !s.shifts.pm) return seedState();
      s.roster = mergeDefaultRoster(s.roster);
      s.rosterVersion = DEFAULT_ROSTER_VERSION;
      // v3 필드 보정 (v2 저장본에는 없음)
      ['am', 'pm'].forEach(function (k) {
        // v10: 시프트 시간은 계산에 쓰이지 않는 표시 전용 값이라 항상
        // 기본값으로 강제한다. 초기 버전에서 잘못 저장된 값(예: 오후
        // 17:00 ~ 17:09)이 버전이 올라가도 계속 따라오는 문제의 수정.
        // 나중에 가게 설정으로 시프트 시간을 바꿀 수 있게 되면 그때
        // 저장값을 존중하면 된다 — 지금은 설정 UI가 없어 강제가 맞다.
        var sdef = SHIFT_DEFS.filter(function (d) { return d.key === k; })[0];
        s.shifts[k].start = sdef.defStart;
        s.shifts[k].end = sdef.defEnd;
        if (!s.shifts[k].suggested) s.shifts[k].suggested = {};
        if (s.shifts[k].photoInfo === undefined) s.shifts[k].photoInfo = null;
        // v9: photoRef 보정 (v8 이전 저장본에는 없음)
        var pr = s.shifts[k].photoRef;
        if (!pr || typeof pr !== 'object' || !pr.id) s.shifts[k].photoRef = null;
        else if (!Array.isArray(pr.suggestedIds)) pr.suggestedIds = [];
        // v7: 완료(done) 필드 보정 (v6 이전 저장본에는 없음)
        s.shifts[k].done = !!s.shifts[k].done;
        // v5: 일한 사람은 매번 직접 눌러 고른다 — 저장된 선택은 불러오지 않는다.
        // v7 예외: "완료"한 시프트는 접힌 요약에 금액을 계속 보여줘야 해서
        // 선택을 유지한다 (수정을 누른 뒤 닫으면 그때부터 다시 비워진다).
        if (!s.shifts[k].done) s.shifts[k].selected = {};
        // v6: 시간/구간 방식 폐기 — segAmounts는 버리고 prepays로 정규화한다.
        delete s.shifts[k].segAmounts;
        if (!Array.isArray(s.shifts[k].prepays)) s.shifts[k].prepays = [];
        s.shifts[k].prepays = s.shifts[k].prepays.filter(function (p) {
          return p && typeof p.personId === 'string';
        }).map(function (p) {
          return { personId: p.personId, amount: p.amount == null ? '' : String(p.amount) };
        });
      });
      return s;
    } catch (e) {
      return seedState();
    }
  }
  var state = loadState();
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 저장 실패 무시 */ }
  }

  // ---------- 날짜 도우미 (전부 기기 현지 날짜 기준) ----------
  // 주의: 날짜 문자열을 new Date('YYYY-MM-DD')로 파싱하면 UTC 자정으로
  // 해석돼 UTC-10(하와이)에서는 전날 14:00이 되어 요일·날짜가 하루 밀린다.
  // 날짜 문자열은 반드시 parseDateStr로 로컬 파싱하고, 키 생성은 fmtDateStr로만.
  function parseDateStr(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function fmtDateStr(d) {
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }
  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }
  // 그 날짜가 속한 주의 일요일 (주는 일요일 시작 ~ 토요일 끝)
  function sundayOf(d) { return addDays(d, -d.getDay()); }
  function dayLabel(d) { return (d.getMonth() + 1) + '월 ' + d.getDate() + '일'; }

  // ---------- 날짜별 인당 합계 기록 (v4) ----------
  // 구조: { "YYYY-MM-DD": { "이름": 그날 인당 팁 합계(달러 숫자) } }
  function loadHistory() {
    try {
      var raw = localStorage.getItem(LS_HISTORY_KEY);
      if (!raw) return {};
      var h = JSON.parse(raw);
      return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
    } catch (e) { return {}; }
  }
  function saveHistory(h) {
    try { localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(h)); } catch (e) { /* 무시 */ }
  }
  // 현재 화면 입력을 사용자가 실제로 건드렸을 때만 true. 날짜만 바꿔서 표를
  // 보러 온 경우에는 false라서 기존 기록을 지우거나 덮지 않는다.
  var inputsDirty = false;

  // 현재 입력이 만들어낼 날짜 기록을 syncHistory와 같은 규칙으로 만든다.
  // 저장될 기록이 없는 상태(총액 0·합계 검증 실패·받은 사람이 없음)면 null.
  // v11 날짜 이동의 덮어쓰기 판정도 이 함수를 써서 "실제로 저장될 기록"과
  // 어긋나지 않게 한다.
  function buildDayEntry(day) {
    if (day.totalCents === 0 || !day.balanced) return null;
    var entry = {};
    Object.keys(day.perPerson).forEach(function (id) {
      var p = personById(id);
      // 0원인 사람은 기록하지 않는다 (총액 0인 시프트에 선택만 돼 있어도
      // perPerson에 0으로 들어오기 때문 — 받은 팁이 있는 사람만 남긴다).
      if (p && day.perPerson[id] > 0) entry[p.name] = Math.round(day.perPerson[id]) / 100;
    });
    return Object.keys(entry).length > 0 ? entry : null;
  }

  // 계산 결과를 현재 선택 날짜의 기록으로 반영한다.
  // - 총액 0 → 그 날짜 기록 삭제 (사용자가 입력을 비운 경우)
  // - 합계 검증 OK → 인당 합계로 저장 (이름 기준, 주방 포함 전 인원)
  // - 선지급 검증 오류 등 미완성 상태 → 기존 기록을 건드리지 않는다
  function syncHistory(day) {
    if (!inputsDirty) return;
    var date = state.date;
    if (!date) return;
    var hist = loadHistory();
    var changed = false;
    if (day.totalCents === 0) {
      if (hist[date]) { delete hist[date]; changed = true; }
    } else if (day.balanced) {
      var entry = buildDayEntry(day);
      if (!entry) {
        if (hist[date]) { delete hist[date]; changed = true; }
      } else if (JSON.stringify(hist[date]) !== JSON.stringify(entry)) {
        hist[date] = entry;
        changed = true;
      }
    }
    if (changed) {
      saveHistory(hist);
      renderCalendar();
    }
  }

  // 두 시프트의 입력(금액·선지급·사진 정보)과 사람 선택을 비운다.
  // 완료(done) 상태도 함께 해제한다 (v7).
  // 시프트 기본 시간은 유지한다. 날짜 변경·사진 날짜 이동·입력 지우기가 공용.
  function clearShiftInputs() {
    SHIFT_DEFS.forEach(function (d) {
      var sh = state.shifts[d.key];
      sh.total = '';
      sh.prepays = [];
      sh.suggested = {};
      sh.photoInfo = null;
      sh.photoRef = null;
      sh.selected = {};
      sh.done = false;
    });
  }

  // ---------- 날짜 이동 (v11) ----------
  // 사진 판독이 정산지 날짜를 잘못 읽으면 기록이 엉뚱한 날짜로 저장되는데,
  // 예전에는 날짜를 바꾸면 입력이 전부 지워져 정정할 방법이 없었다.
  // 이제 입력(팁 금액)이 있는 상태에서 상단 날짜 칸을 바꾸면 입력이 새
  // 날짜로 따라가고, 옛 날짜에 저장된 이 입력의 기록도 함께 옮겨진다.
  // 덮어쓰기 확인 대기 중인 이동 { newDate } — 확인 전까지 날짜는 안 바뀐다.
  var pendingDateMove = null;

  function currentDayResult() {
    return TipCalc.computeDay([
      computeForShift(state.shifts.am).result,
      computeForShift(state.shifts.pm).result,
    ]);
  }

  // "입력이 있는 상태"인지: 사용자가 이번 날짜에서 실제로 건드렸고(inputsDirty)
  // 팁 금액이 들어 있어야 한다. 금액 없이 사람만 고른 상태는 기록이 없어서
  // 기존 둘러보기 동작으로 충분하다. 앱을 다시 열면 inputsDirty가 false라
  // 지난 세션의 입력이 멋대로 따라다니지도 않는다.
  function canMoveInputs() {
    if (!inputsDirty) return false;
    return SHIFT_DEFS.some(function (d) {
      return TipCalc.toCents(state.shifts[d.key].total) > 0;
    });
  }

  function hideDateMoveConfirm() {
    pendingDateMove = null;
    var bar = $('#dateMoveConfirm');
    if (bar) bar.hidden = true;
  }

  function showDateMoveConfirm(newDate) {
    pendingDateMove = { newDate: newDate };
    var bar = $('#dateMoveConfirm');
    var msg = $('#dateMoveMsg');
    var d = parseDateStr(newDate);
    if (msg && d) {
      msg.textContent = dayLabel(d) + ' (' + DOW_LABELS[d.getDay()] +
        '요일)에 이미 기록이 있어요. 지금 입력을 그 날짜로 옮기면, ' +
        '그날 기록은 지금 입력으로 바뀌어요.';
    }
    if (bar) bar.hidden = false;
  }

  // 날짜 이동 적용: 옛 날짜에 저장된 이 입력의 기록은 지우고, 입력은
  // 지우지 않은 채 날짜만 바꾼다 — renderResults → syncHistory가 같은
  // 입력을 새 날짜 기록으로 다시 저장한다 (inputsDirty는 유지).
  function applyDateMove(newDate) {
    var hist = loadHistory();
    if (hist[state.date]) {
      delete hist[state.date];
      saveHistory(hist);
    }
    state.date = newDate;
    var di = $('#dateInput');
    if (di) di.value = newDate;
    calYearMonth = null;
    hideDateMoveConfirm();
    save();
    renderAll();
  }

  // 입력이 없을 때의 날짜 이동 (기존 둘러보기 동작): 입력은 비워지고,
  // inputsDirty를 false로 둬서 기존 기록이 지워지거나 덮어씌워지지 않는다.
  function navigateDate(newDate) {
    state.date = newDate;
    clearShiftInputs();
    inputsDirty = false;
    calYearMonth = null;
    hideDateMoveConfirm();
    save();
    renderAll();
  }

  // 상단 날짜 칸 변경의 진입점.
  // - 입력이 없으면 둘러보기 이동.
  // - 입력이 있으면 이동. 단, 새 날짜에 다른 기록이 이미 있으면 덮기 전에
  //   인라인 확인 바를 띄우고, 확인 전까지 날짜 칸을 원래 날짜로 되돌려 둔다
  //   (확인하지 않으면 아무것도 바뀌지 않는다).
  function attemptDateChange(newDate) {
    if (!canMoveInputs()) { navigateDate(newDate); return; }
    var entry = buildDayEntry(currentDayResult());
    var existing = loadHistory()[newDate];
    if (entry && existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      var di = $('#dateInput');
      if (di) di.value = state.date;
      showDateMoveConfirm(newDate);
      return;
    }
    applyDateMove(newDate);
  }

  // ---------- 도우미 ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function personById(id) {
    for (var i = 0; i < state.roster.length; i++) {
      if (state.roster[i].id === id) return state.roster[i];
    }
    return null;
  }
  function fmt(cents) {
    if (cents == null) return '–';
    var sign = cents < 0 ? '-' : '';
    var v = Math.abs(cents) / 100;
    return sign + '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // ---------- 계산 연결 ----------
  function computeForShift(shift) {
    var kitchenIds = [];
    var serverIds = [];
    Object.keys(shift.selected).forEach(function (id) {
      var p = personById(id);
      if (!p) return;
      if (p.role === 'kitchen') kitchenIds.push(id);
      else serverIds.push(id);
    });
    // 선지급은 그 시프트에서 선택된 사람의 것만 계산에 넣는다.
    var prepays = (shift.prepays || []).filter(function (p) {
      return !!shift.selected[p.personId];
    }).map(function (p) {
      return { personId: p.personId, amountCents: TipCalc.toCents(p.amount) };
    });
    var result = TipCalc.computeShift({
      totalCents: TipCalc.toCents(shift.total),
      kitchenIds: kitchenIds,
      serverIds: serverIds,
      prepays: prepays,
    });
    return { result: result };
  }

  // v12: 표시용 경고 필터. 총액이 아직 없는(0/빈칸) 시프트에서는
  // "선지급 합계가 팁 총액과 같거나 많아요" 경고가 총액을 넣기도 전에 떠서
  // "금액이 틀렸다"는 오해를 부른다. 그 상태에서는 완료 버튼 위 안내 문구가
  // 우선이므로 이 경고만 표시에서 뺀다 (calc.js의 계산·경고 생성은 그대로).
  function visibleWarnings(result) {
    if (result.totalCents > 0) return result.warnings;
    return result.warnings.filter(function (w) {
      return w.indexOf('합계가 팁 총액과 같거나') === -1;
    });
  }

  // ---------- 사진 판독 (v3) ----------
  // 진행 상태는 저장하지 않는 화면 전용 상태 (렌더를 다시 해도 유지되게 렌더 밖에서 관리).
  // v9 필드: active(업로드·폴링 진행 중), cancelled(지우기로 취소됨),
  // pendingId/pendingPath(진행 중인 행·파일), confirmUntil(지우기 인라인 확인 만료 시각).
  function freshPhotoUi() {
    return { busy: false, msg: '', active: false, cancelled: false,
             pendingId: null, pendingPath: null, confirmUntil: 0, generation: 0 };
  }
  var photoUi = { am: freshPhotoUi(), pm: freshPhotoUi() };

  function setPhotoStatus(key, msg) {
    photoUi[key].msg = msg;
    var section = document.getElementById('shift-' + key);
    var box = section ? section.querySelector('[data-photo-status]') : null;
    if (box) box.textContent = msg;
    var btn = section ? section.querySelector('[data-photo-btn]') : null;
    if (btn) btn.disabled = photoUi[key].busy;
  }

  // 판독 실패 안내 (v11): 사진이 잘 안 찍혀 인식이 안 돼도, 날짜를 골라
  // 직접 입력하면 그 날짜로 저장된다 — 그 길로 자연스럽게 유도한다.
  function photoFailMessage(reason) {
    var msg = '⚠ ' + (reason || '판독에 실패했어요.');
    if (msg.indexOf('직접 입력') < 0) {
      msg += ' 인식이 안 되면 날짜를 골라서 직접 입력해도 돼요.';
    }
    return msg;
  }
  function guideToDateInput() {
    var di = $('#dateInput');
    if (!di) return;
    if (di.scrollIntoView) di.scrollIntoView({ behavior: 'smooth', block: 'center' });
    di.classList.add('date-flash');
    setTimeout(function () { di.classList.remove('date-flash'); }, 2100);
  }

  // 판독 완료 행을 시프트에 반영: 팁 총액은 정산 시각으로 판정한 시프트에 넣고,
  // 손글씨 이름은 선택하지 않고 "제안"으로만 표시한다 (확정은 사용자 탭).
  // v4: 정산지 날짜가 현재 선택 날짜와 다르면 날짜를 그쪽으로 바꾸고 입력을
  // 비운 뒤 채운다 — 다른 날짜의 입력이 섞여 잘못 저장되는 것을 막는다.
  function applyPhotoResult(fromKey, row, meta) {
    var photoDate = null;
    if (row.settled_time && /^\d{4}-\d{2}-\d{2}/.test(String(row.settled_time))) {
      photoDate = String(row.settled_time).slice(0, 10);
    } else if (row.raw && row.raw.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.raw.date))) {
      photoDate = String(row.raw.date).slice(0, 10);
    }
    if (photoDate && photoDate !== state.date) {
      state.date = photoDate;
      var di = $('#dateInput');
      if (di) di.value = photoDate;
      clearShiftInputs();
      calYearMonth = null;
      hideDateMoveConfirm();
    }
    inputsDirty = true;
    var targetKey = TipPhoto.decideShift(row.settled_time) || fromKey;
    var shift = state.shifts[targetKey];
    // v9: 이 자리에 다른 사진이 붙어 있었다면 그 행·파일은 정리한다 (교체).
    var oldRef = shift.photoRef;
    if (oldRef && (!meta || oldRef.id !== meta.id)) {
      TipPhoto.cancelRow(oldRef.id);
      TipPhoto.deletePhotoFile(oldRef.path);
    }
    if (row.tip_amount != null) shift.total = String(row.tip_amount);
    var readNames = Array.isArray(row.names) ? row.names : [];
    var m = TipPhoto.matchNames(readNames, state.roster);
    if (!shift.suggested) shift.suggested = {};
    var addedSuggested = [];
    m.matched.forEach(function (x) {
      if (!shift.selected[x.personId]) {
        shift.suggested[x.personId] = x.readName;
        addedSuggested.push(x.personId);
      }
    });
    var rawTime = (row.raw && row.raw.time) ||
      (row.settled_time ? String(row.settled_time).slice(11) : '');
    shift.photoInfo = {
      purchase: row.purchase_amount != null ? row.purchase_amount : null,
      tickets: row.ticket_count != null ? row.ticket_count : null,
      time: rawTime,
      date: photoDate, // v11: 정산지 날짜를 눈에 보이게 표시 (정정 안내 포함)
      fromOther: targetKey !== fromKey ? fromKey : null,
      unmatched: m.unmatched,
    };
    // v9: 사진이 채운 것을 기록한다 — 지울 때 이 기록과 현재 값을 비교해
    // 사진이 넣은 것만 되돌리고, 사용자가 손으로 고친 값은 건드리지 않는다.
    shift.photoRef = meta ? {
      id: meta.id,
      path: meta.path || null,
      totalValue: row.tip_amount != null ? String(row.tip_amount) : null,
      suggestedIds: addedSuggested,
    } : null;
    save();
    photoUi[targetKey].busy = false;
    photoUi[targetKey].active = false;
    photoUi[targetKey].pendingId = null;
    photoUi[targetKey].pendingPath = null;
    setPhotoStatus(targetKey, '✓ 판독 완료 — 금액과 사람이 맞는지 확인해 주세요.');
    renderShift(targetKey);
    if (targetKey !== fromKey) {
      photoUi[fromKey].busy = false;
      photoUi[fromKey].active = false;
      photoUi[fromKey].pendingId = null;
      photoUi[fromKey].pendingPath = null;
      setPhotoStatus(fromKey, '사진은 ' + (targetKey === 'am' ? '오전' : '오후') +
        ' 시프트에 넣었어요.');
      renderShift(fromKey);
      var target = document.getElementById('shift-' + targetKey);
      if (target && target.scrollIntoView) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    renderResults();
  }

  function handlePhoto(key, file) {
    if (!file || photoUi[key].busy) return;
    var ui = photoUi[key];
    // 세대(generation) 토큰: 지우거나 새 업로드를 시작하면 이전 비동기 흐름은
    // stale이 되어 화면 상태를 건드리지 않는다 (늦은 결과로 되살아나는 것 방지).
    var gen = (ui.generation || 0) + 1;
    ui.generation = gen;
    function stale() { return ui.generation !== gen; }
    ui.busy = true;
    ui.active = true;
    ui.cancelled = false;
    ui.pendingId = null;
    ui.pendingPath = null;
    ui.confirmUntil = 0;
    ui.msg = '사진을 올리고 있어요…';
    renderShift(key); // 지우기 버튼이 바로 보이게 다시 그린다
    TipPhoto.uploadAndCreate(file).then(function (up) {
      if (stale()) {
        // 그사이 지웠거나 새 사진이 시작됐다 — 이 행은 고아가 되지 않게 취소만 한다.
        TipPhoto.cancelRow(up.id);
        TipPhoto.deletePhotoFile(up.path);
        return null;
      }
      ui.pendingId = up.id;
      ui.pendingPath = up.path;
      setPhotoStatus(key, '판독 중이에요…');
      return TipPhoto.pollResult(up.id, function (sec) {
        if (!stale()) setPhotoStatus(key, '판독 중이에요… (' + sec + '초)');
      }, function () { return ui.cancelled || stale(); }).then(function (row) {
        return { row: row, meta: up };
      });
    }).then(function (res) {
      if (!res || stale()) return; // 지우기로 취소됐거나 옛 세대 흐름
      var row = res.row;
      if (row.status === 'error') {
        ui.busy = false;
        ui.active = false;
        ui.pendingId = null;
        ui.pendingPath = null;
        setPhotoStatus(key, photoFailMessage(row.error));
        renderShift(key);
        guideToDateInput();
        return;
      }
      applyPhotoResult(key, row, res.meta);
    }).catch(function (e) {
      if (stale()) return;
      ui.busy = false;
      ui.active = false;
      ui.pendingId = null;
      ui.pendingPath = null;
      if (e && e.cancelled) {
        // 사진 지우기로 멈춘 폴링 — 지우기 쪽이 이미 안내를 띄웠다.
        renderShift(key);
        return;
      }
      setPhotoStatus(key, photoFailMessage(e && e.message ? e.message : '사진을 처리하지 못했어요.'));
      renderShift(key);
      guideToDateInput();
    });
  }

  // ---------- 사진 지우기 (v9) ----------
  // 확인은 가장 가볍게: 버튼을 한 번 누르면 "정말 지울까요?" 문구로 바뀌고,
  // 3초 안에 한 번 더 누르면 지워진다 (모달 없음 — 매일 쓰는 도구라 빠르게).
  var PHOTO_DEL_LABEL = '사진 지우기';
  var PHOTO_DEL_CONFIRM_LABEL = '정말 지울까요? 한 번 더 누르면 지워져요';

  function armPhotoDeleteConfirm(key, btn) {
    photoUi[key].confirmUntil = Date.now() + 3000;
    btn.textContent = PHOTO_DEL_CONFIRM_LABEL;
    btn.classList.add('confirming');
    setTimeout(function () {
      if (photoUi[key].confirmUntil &&
          photoUi[key].confirmUntil <= Date.now()) {
        photoUi[key].confirmUntil = 0;
        var section = document.getElementById('shift-' + key);
        var b = section ? section.querySelector('[data-photo-del-btn]') : null;
        if (b) {
          b.textContent = PHOTO_DEL_LABEL;
          b.classList.remove('confirming');
        }
      }
    }, 3100);
  }

  function onPhotoDeleteClick(key, btn) {
    if (photoUi[key].confirmUntil > Date.now()) {
      photoUi[key].confirmUntil = 0;
      executePhotoDelete(key);
    } else {
      armPhotoDeleteConfirm(key, btn);
    }
  }

  function executePhotoDelete(key) {
    var ui = photoUi[key];
    var shift = state.shifts[key];
    if (ui.active) {
      // 판독 중인 사진: 세대를 올려 폴링 흐름을 stale로 만든다 — 늦게 도착하는
      // 판독 결과는 버려지고, 이미 만들어진 행이 있으면 취소까지 건다.
      // (업로드 자체가 아직 안 끝났으면, 끝나는 순간 그 흐름이 stale을 보고
      // 행·파일을 스스로 취소한다.)
      ui.generation = (ui.generation || 0) + 1;
      ui.cancelled = true;
      ui.busy = false;
      ui.active = false;
      if (ui.pendingId) {
        TipPhoto.cancelRow(ui.pendingId);
        TipPhoto.deletePhotoFile(ui.pendingPath);
        ui.pendingId = null;
        ui.pendingPath = null;
      }
      ui.msg = '사진을 지웠어요. 다시 올릴 수 있어요.';
      save();
      renderShift(key);
      renderResults();
      return;
    }
    var ref = shift.photoRef;
    if (!ref) return;
    // 사진이 채운 것만 되돌린다: 총액은 사진이 넣은 값과 지금 값이 같을 때만
    // 비우고, 이름 제안은 이 사진이 제안한 것만 지운다. 사용자가 탭해서 확정한
    // 선택이나 손으로 고친 금액은 건드리지 않는다.
    if (ref.totalValue != null && shift.total === ref.totalValue) {
      shift.total = '';
    }
    (ref.suggestedIds || []).forEach(function (id) {
      if (shift.suggested) delete shift.suggested[id];
    });
    shift.photoInfo = null;
    shift.photoRef = null;
    TipPhoto.cancelRow(ref.id);
    TipPhoto.deletePhotoFile(ref.path);
    inputsDirty = true; // 총액이 비워졌으면 그날 기록도 다시 맞춘다
    ui.msg = '사진을 지웠어요. 다시 올릴 수 있어요.';
    save();
    renderShift(key);
    renderResults();
  }

  // ---------- 명단 렌더 ----------
  function renderRoster() {
    var box = $('#rosterList');
    if (state.roster.length === 0) {
      box.innerHTML = '<p class="empty-note">아직 등록된 직원이 없어요. 아래에서 이름을 추가해 주세요.</p>';
      return;
    }
    box.innerHTML = state.roster.map(function (p) {
      return '<div class="roster-item">' +
        '<span class="roster-name">' + esc(p.name) + '</span>' +
        '<span class="role-badge' + (p.role === 'kitchen' ? ' kitchen' : '') + '">' +
          (p.role === 'kitchen' ? '주방' : '서버') + '</span>' +
        '<button type="button" class="btn btn-small" data-role-toggle="' + p.id + '">' +
          (p.role === 'kitchen' ? '서버로 바꾸기' : '주방으로 바꾸기') + '</button>' +
        '<button type="button" class="btn btn-small btn-danger" data-delete-person="' + p.id + '">삭제</button>' +
      '</div>';
    }).join('');
  }

  // ---------- 시프트 카드 렌더 ----------
  // 완료된 시프트의 요약 (v7): 사람별 금액 + 구성(선지급 순액·주방 몫·나눈 몫)
  function doneSummaryHtml(shift, result) {
    var rows = state.roster.filter(function (p) {
      return result.perPerson[p.id] != null || shift.selected[p.id];
    });
    var lines = rows.map(function (p) {
      var d = result.perPersonDetail[p.id] ||
        { prepayCents: 0, kitchenCents: 0, serverCents: 0 };
      var parts = [];
      if (d.prepayCents > 0) parts.push('먼저 떼어줌 ' + fmt(d.prepayCents));
      if (d.kitchenCents > 0) parts.push('주방 몫 ' + fmt(d.kitchenCents));
      if (d.serverCents > 0 && (d.prepayCents > 0 || d.kitchenCents > 0)) {
        parts.push('나눈 몫 ' + fmt(d.serverCents));
      }
      var sub = parts.length > 0
        ? '<div class="done-sub">' + esc(parts.join(' + ')) + '</div>' : '';
      return '<div class="done-line"><div class="done-person">' +
        '<span class="done-name">' + esc(p.name) +
        (p.role === 'kitchen' ? ' <span class="role-badge kitchen">주방</span>' : '') +
        '</span>' + sub + '</div>' +
        '<span class="done-amt">' + fmt(result.perPerson[p.id]) + '</span></div>';
    }).join('');
    if (!lines) lines = '<p class="result-empty">표시할 내역이 없어요.</p>';
    return '<div class="done-box"><p class="done-title">✓ 입력 완료</p>' +
      '<div class="done-lines">' + lines + '</div>' +
      '<div class="done-line done-total-row"><span class="done-name">팁 총액</span>' +
      '<span class="done-amt">' + fmt(result.totalCents) + '</span></div>' +
      '<button type="button" class="btn edit-btn" data-edit-btn>수정</button></div>';
  }

  function renderShift(key) {
    var def = SHIFT_DEFS.filter(function (d) { return d.key === key; })[0];
    var shift = state.shifts[key];
    var section = $('#shift-' + key);
    var computed = computeForShift(shift);
    var result = computed.result;

    // v7: 완료된 시프트는 입력을 접고 요약만 보여준다.
    if (shift.done) {
      section.innerHTML =
        '<div class="shift-head"><h2>' + def.title + '</h2>' +
        '<span class="shift-time-label">' + esc(shift.start) + ' ~ ' + esc(shift.end) + '</span></div>' +
        doneSummaryHtml(shift, result) +
        '<div class="shift-warnings" data-warnings></div>';
      var editBtn = $('[data-edit-btn]', section);
      if (editBtn) {
        editBtn.addEventListener('click', function () {
          shift.done = false;
          save();
          renderShift(key);
          renderResults();
        });
      }
      updateShiftWarnings(key, section);
      return;
    }

    var chipsHtml = state.roster.map(function (p) {
      var on = !!shift.selected[p.id];
      var suggested = !on && !!(shift.suggested && shift.suggested[p.id]);
      return '<button type="button" class="chip' + (on ? ' on' : '') +
        (suggested ? ' suggested' : '') + '" data-chip="' + p.id + '">' +
        esc(p.name) +
        (suggested ? '<span class="suggest-badge">사진 판독</span>' : '') +
        '<span class="role-badge' + (p.role === 'kitchen' ? ' kitchen' : '') + '">' +
          (p.role === 'kitchen' ? '주방' : '서버') + '</span>' +
      '</button>';
    }).join('');

    var kitchenNames = Object.keys(shift.selected).filter(function (id) {
      var p = personById(id); return p && p.role === 'kitchen';
    }).map(function (id) { return personById(id).name; });
    var kitchenHtml = '';
    if (kitchenNames.length > 0) {
      // v7: 주방 몫은 선지급에서도 먼저 가므로 언제나 팁 전체의 10%다.
      kitchenHtml = '<p class="kitchen-note">🍳 주방 ' + esc(kitchenNames.join(', ')) +
        ' — 팁 전체의 10%인 <span data-kitchen-amount>' + fmt(result.kitchenTotalCents) +
        '</span>를 나눠 가져요.</p>';
    }

    // 선지급 섹션 (v6): 먼저 온 사람에게 먼저 떼어줄 금액 지정.
    // 행은 shift.prepays의 실제 인덱스를 들고 다니고, 선택된 사람의 행만 보여준다.
    var advHtml = '';
    if (shift.advancedOpen) {
      advHtml += '<div class="advanced">';
      advHtml += '<div class="adv-block"><p class="adv-title">먼저 떼어주기</p>';
      var selPeople = state.roster.filter(function (p) { return !!shift.selected[p.id]; });
      if (selPeople.length === 0) {
        advHtml += '<p class="hint">먼저 위에서 일한 사람을 선택해 주세요.</p>';
      } else {
        (shift.prepays || []).forEach(function (pp, idx) {
          if (!shift.selected[pp.personId]) return; // 선택 해제된 사람의 행은 숨김 (값은 유지)
          var opts = selPeople.map(function (p) {
            return '<option value="' + p.id + '"' +
              (p.id === pp.personId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
          }).join('');
          // v12: 행별 확인/수정 잠금. locked는 세션 내 UI 상태일 뿐이라
          // loadState 정규화({personId, amount}로 재구성)에서 버려진다 —
          // 새로고침하면 잠금은 풀리고 편집 상태로 시작한다.
          var locked = !!pp.locked;
          advHtml += '<div class="prepay-row' + (locked ? ' locked' : '') + '">' +
            '<select data-prepay-person="' + idx + '" aria-label="먼저 떼어줄 사람"' +
              (locked ? ' disabled' : '') + '>' + opts + '</select>' +
            '<div class="money-wrap"><span class="dollar">$</span>' +
            '<input type="number" class="money-input prepay-input" inputmode="decimal" min="0" step="0.01" ' +
            'placeholder="0.00" data-prepay-amount="' + idx + '" value="' + esc(String(pp.amount)) + '"' +
              (locked ? ' disabled' : '') + '></div>' +
            '<button type="button" class="btn btn-small prepay-lock-btn" data-prepay-lock="' + idx + '">' +
              (locked ? '수정' : '확인') + '</button>' +
            '<button type="button" class="btn btn-small btn-danger" data-prepay-del="' + idx + '">삭제</button>' +
          '</div>';
        });
        advHtml += '<button type="button" class="btn prepay-add" data-prepay-add>+ 먼저 떼어주기 추가</button>';
        advHtml += '<p class="hint">먼저 온 사람이 혼자 일한 몫을 영수증에서 보고 먼저 떼어줘요. ' +
          '먼저 떼어준 금액에서도 10%는 주방 몫으로 가고(주방이 있을 때), 남은 금액에서도 ' +
          '주방이 10%를 가져간 뒤 나머지는 일한 서버가 똑같이 나눠요. ' +
          '먼저 떼어준 사람도 똑같이 나누는 데는 그대로 참여해요.</p>';
      }
      advHtml += '</div></div>';
    }

    var photoInfoHtml = '';
    if (shift.photoInfo) {
      var pi = shift.photoInfo;
      var bits = [];
      if (pi.purchase != null) bits.push('매출 ' + fmt(TipCalc.toCents(pi.purchase)));
      if (pi.tickets != null) bits.push('티켓 ' + pi.tickets + '장');
      if (pi.time) bits.push('정산 ' + esc(pi.time));
      photoInfoHtml = '<div class="photo-info">';
      if (bits.length > 0) photoInfoHtml += '<div>📷 사진 판독 — ' + bits.join(' · ') + '</div>';
      // v11: 정산지 날짜를 명시한다. 날짜를 잘못 읽으면 기록이 엉뚱한 날짜로
      // 저장되므로, 사용자가 바로 알아채고 날짜 칸에서 정정할 수 있게.
      var photoDateObj = pi.date ? parseDateStr(pi.date) : null;
      if (photoDateObj) {
        photoInfoHtml += '<div>🗓 정산지 날짜: ' + dayLabel(photoDateObj) +
          ' (' + DOW_LABELS[photoDateObj.getDay()] + ')</div>';
        photoInfoHtml += '<div class="photo-note">날짜가 실제와 다르면 위 날짜 칸에서 ' +
          '바꾸세요 — 입력이 같이 옮겨가요.</div>';
      }
      if (pi.fromOther) {
        photoInfoHtml += '<div class="photo-note">↪ ' +
          (pi.fromOther === 'am' ? '오전' : '오후') +
          ' 카드에서 올린 사진인데, 정산 시각으로 이 시프트에 넣었어요.</div>';
      }
      if (pi.unmatched && pi.unmatched.length > 0) {
        photoInfoHtml += '<div class="photo-note">읽은 이름 중 명단에 없는 이름: ' +
          esc(pi.unmatched.join(', ')) + ' — 맞으면 위에서 직접 눌러주세요.</div>';
      }
      photoInfoHtml += '</div>';
    }

    // 사진 지우기 버튼 (v9): 판독 중이거나 사진이 붙어 있을 때만 보인다.
    var photoDelHtml = '';
    if (photoUi[key].active || shift.photoRef) {
      var confirming = photoUi[key].confirmUntil > Date.now();
      photoDelHtml = '<div class="photo-del-row">' +
        '<button type="button" class="btn btn-danger photo-del-btn' +
        (confirming ? ' confirming' : '') + '" data-photo-del-btn>' +
        (confirming ? PHOTO_DEL_CONFIRM_LABEL : PHOTO_DEL_LABEL) + '</button></div>';
    }

    // 카드 내부 순서 (v6): 일한 사람 칩 → 사진으로 채우기 → 팁 총액 → 선지급 옵션.
    // 사람이 먼저 선택돼 있어도 사진 판독 제안은 기존 방식 그대로 동작한다.
    section.innerHTML =
      '<div class="shift-head"><h2>' + def.title + '</h2>' +
      '<span class="shift-time-label">' + esc(shift.start) + ' ~ ' + esc(shift.end) + '</span></div>' +
      '<p class="chips-label">일한 사람 (눌러서 선택)</p>' +
      '<div class="chips">' + chipsHtml + '</div>' +
      '<div class="photo-row">' +
      '<button type="button" class="btn photo-btn" data-photo-btn' +
        (photoUi[key].busy ? ' disabled' : '') + '>📷 사진으로 채우기</button>' +
      '<input type="file" accept="image/*" class="photo-input" data-photo-input hidden>' +
      '</div>' +
      '<div class="photo-status" data-photo-status>' + esc(photoUi[key].msg) + '</div>' +
      photoInfoHtml +
      photoDelHtml +
      '<div class="total-row"><label for="total-' + key + '">팁 총액</label>' +
      '<div class="money-wrap"><span class="dollar">$</span>' +
      '<input type="number" class="money-input" id="total-' + key + '" inputmode="decimal" min="0" step="0.01" ' +
      'placeholder="0.00" data-total-input value="' + esc(String(shift.total)) + '"></div></div>' +
      kitchenHtml +
      '<button type="button" class="btn advanced-toggle" data-advanced-toggle>' +
        (shift.advancedOpen ? '먼저 떼어주기 닫기' : '먼저 온 사람에게 먼저 떼어줄 금액이 있으면 눌러주세요') +
      '</button>' +
      advHtml +
      '<div class="shift-warnings" data-warnings></div>' +
      // v12: 완료 버튼이 꺼져 있는 이유 안내 (updateShiftWarnings가 채운다)
      '<div class="done-hint" data-done-hint></div>' +
      '<button type="button" class="btn btn-primary complete-btn" data-done-btn' +
        (TipCalc.toCents(shift.total) > 0 && result.balanced ? '' : ' disabled') +
        '>완료</button>';

    attachShiftListeners(key, section);
    updateShiftWarnings(key, section);
  }

  function updateShiftWarnings(key, section) {
    var shift = state.shifts[key];
    var result = computeForShift(shift).result;
    var box = $('[data-warnings]', section);
    if (box) {
      box.innerHTML = visibleWarnings(result).map(function (w) {
        return '<div class="warning">⚠ ' + esc(w) + '</div>';
      }).join('');
    }
    var kAmt = $('[data-kitchen-amount]', section);
    if (kAmt) kAmt.textContent = fmt(result.kitchenTotalCents);
    // v7: 완료 버튼은 계산이 유효할 때만 (총액 있고 합계 검증 OK)
    var doneBtn = $('[data-done-btn]', section);
    if (doneBtn) {
      doneBtn.disabled = !(TipCalc.toCents(shift.total) > 0 && result.balanced);
    }
    // v12: 버튼이 꺼진 이유가 "총액 미입력"이면 버튼 바로 위에 안내를 보여준다.
    // (그 외 사유 — 선지급 초과·서버 미선택 등 — 는 경고 박스가 이미 설명한다.)
    var hint = $('[data-done-hint]', section);
    if (hint) {
      hint.textContent = (doneBtn && doneBtn.disabled && TipCalc.toCents(shift.total) <= 0)
        ? '팁 총액을 입력하면 완료할 수 있어요' : '';
    }
  }

  function attachShiftListeners(key, section) {
    var shift = state.shifts[key];

    var totalInput = $('[data-total-input]', section);
    totalInput.addEventListener('input', function () {
      shift.total = totalInput.value;
      inputsDirty = true;
      save();
      updateShiftWarnings(key, section);
      renderResults();
    });

    section.querySelectorAll('[data-chip]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-chip');
        inputsDirty = true;
        if (shift.selected[id]) delete shift.selected[id];
        else shift.selected[id] = {};
        // 사진 판독 제안은 탭하는 순간 확정/해제되므로 제안 표시를 지운다.
        if (shift.suggested) delete shift.suggested[id];
        save();
        renderShift(key);
        renderResults();
      });
    });

    var photoBtn = $('[data-photo-btn]', section);
    var photoInput = $('[data-photo-input]', section);
    if (photoBtn && photoInput) {
      photoBtn.addEventListener('click', function () { photoInput.click(); });
      photoInput.addEventListener('change', function () {
        var file = photoInput.files && photoInput.files[0];
        photoInput.value = ''; // 같은 파일을 다시 골라도 change가 발생하게
        handlePhoto(key, file);
      });
    }

    // v9: 사진 지우기 (인라인 확인 — 한 번 누르면 확인 문구, 한 번 더 누르면 삭제)
    var photoDelBtn = $('[data-photo-del-btn]', section);
    if (photoDelBtn) {
      photoDelBtn.addEventListener('click', function () {
        onPhotoDeleteClick(key, photoDelBtn);
      });
    }

    var advBtn = $('[data-advanced-toggle]', section);
    advBtn.addEventListener('click', function () {
      shift.advancedOpen = !shift.advancedOpen;
      save();
      renderShift(key);
    });

    // 선지급 행: 사람 변경 / 금액 입력 / 삭제 / 추가
    section.querySelectorAll('[data-prepay-person]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var row = shift.prepays[+sel.getAttribute('data-prepay-person')];
        if (!row) return;
        row.personId = sel.value;
        inputsDirty = true;
        save();
        renderShift(key);
        renderResults();
      });
    });
    section.querySelectorAll('[data-prepay-amount]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var row = shift.prepays[+inp.getAttribute('data-prepay-amount')];
        if (!row) return;
        row.amount = inp.value;
        inputsDirty = true;
        save();
        updateShiftWarnings(key, section);
        renderResults();
      });
    });
    section.querySelectorAll('[data-prepay-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        shift.prepays.splice(+btn.getAttribute('data-prepay-del'), 1);
        inputsDirty = true;
        save();
        renderShift(key);
        renderResults();
      });
    });
    // v12: 선지급 행 확인/수정 잠금 토글. 잠금은 순수 UI 상태라 계산에는
    // 영향이 없고(잠겨 있어도 현재 값으로 실시간 계산), 삭제는 잠긴
    // 상태에서도 그대로 된다. done(완료) 상태와도 무관하다.
    section.querySelectorAll('[data-prepay-lock]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = shift.prepays[+btn.getAttribute('data-prepay-lock')];
        if (!row) return;
        row.locked = !row.locked;
        save();
        renderShift(key);
        renderResults();
      });
    });
    var addBtn = $('[data-prepay-add]', section);
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var first = state.roster.filter(function (p) { return !!shift.selected[p.id]; })[0];
        if (!first) return;
        if (!Array.isArray(shift.prepays)) shift.prepays = [];
        shift.prepays.push({ personId: first.id, amount: '' });
        inputsDirty = true;
        save();
        renderShift(key);
        renderResults();
      });
    }

    // v7: 완료 버튼 — 유효한 계산일 때만 눌리고, 누르면 카드가 접힌다.
    var doneBtn = $('[data-done-btn]', section);
    if (doneBtn) {
      doneBtn.addEventListener('click', function () {
        var r = computeForShift(shift).result;
        if (!(TipCalc.toCents(shift.total) > 0 && r.balanced)) return;
        shift.done = true;
        save();
        renderShift(key);
        renderResults();
      });
    }
  }

  // ---------- 결과 렌더 ----------
  function renderResults() {
    var body = $('#resultBody');
    var amRes = computeForShift(state.shifts.am).result;
    var pmRes = computeForShift(state.shifts.pm).result;
    var day = TipCalc.computeDay([amRes, pmRes]);
    syncHistory(day);

    if (day.totalCents === 0) {
      body.innerHTML = '<p class="result-empty">위에서 팁 총액을 입력하면 여기에 사람별 정산이 나와요.</p>';
      return;
    }

    var rows = state.roster.filter(function (p) {
      return day.perPerson[p.id] != null ||
        state.shifts.am.selected[p.id] || state.shifts.pm.selected[p.id];
    });
    var html = '<table class="result"><thead><tr>' +
      '<th>이름</th><th class="col-am">오전</th><th class="col-pm">오후</th><th>합계</th></tr></thead><tbody>';
    rows.forEach(function (p) {
      // 총액이 0인 시프트는 나눈 금액이 없으므로 '–'로 표시
      var amVal = amRes.totalCents === 0 ? null : amRes.perPerson[p.id];
      var pmVal = pmRes.totalCents === 0 ? null : pmRes.perPerson[p.id];
      html += '<tr><td class="p-name">' + esc(p.name) +
        (p.role === 'kitchen' ? ' <span class="role-badge kitchen">주방</span>' : '') + '</td>' +
        '<td class="col-am">' + fmt(amVal) + '</td>' +
        '<td class="col-pm">' + fmt(pmVal) + '</td>' +
        '<td class="p-total">' + fmt(day.perPerson[p.id]) + '</td></tr>';
    });
    html += '</tbody><tfoot><tr><td>전체</td><td class="col-am">' + fmt(amRes.totalCents) + '</td><td class="col-pm">' +
      fmt(pmRes.totalCents) + '</td><td>' + fmt(day.totalCents) + '</td></tr></tfoot></table>';

    if (day.balanced) {
      html += '<div class="verify ok">✓ 합계가 맞아요 — 총 ' + fmt(day.totalCents) +
        '가 빠짐없이 나뉘었어요.</div>';
    } else {
      html += '<div class="verify bad">⚠ 아직 합계가 안 맞아요 — 입력한 팁 ' + fmt(day.totalCents) +
        ' / 나뉜 금액 ' + fmt(day.distributedCents) + '</div>';
    }

    var warns = [];
    visibleWarnings(amRes).forEach(function (w) { warns.push('오전: ' + w); });
    visibleWarnings(pmRes).forEach(function (w) { warns.push('오후: ' + w); });
    if (warns.length > 0) {
      html += '<div class="result-warnings">' + warns.map(function (w) {
        return '<div class="warning">⚠ ' + esc(w) + '</div>';
      }).join('') + '</div>';
    }
    body.innerHTML = html;
  }

  // ---------- 날짜별 기록 달력 (v7: 주급 정산표 대체) ----------
  // 달력에서 날짜를 고르면 그날의 인당 내역이 아래에 뜨고, 선택 날짜부터
  // 2주(14일) 기간으로 "팁 지급하기" 내역을 만들 수 있다.
  var DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
  // 달력에 보고 있는 달 {y, m}. null이면 선택 날짜의 달을 따라간다.
  var calYearMonth = null;
  function rosterIndexOf(name) {
    for (var i = 0; i < state.roster.length; i++) {
      if (state.roster[i].name === name) return i;
    }
    return -1;
  }
  // 기록 항목의 이름들을 명단 순서로 정렬 (명단에 없으면 뒤에, 등장 순)
  function sortedNames(entry) {
    var names = Object.keys(entry || {});
    names.sort(function (a, b) {
      var ia = rosterIndexOf(a);
      var ib = rosterIndexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return 0;
    });
    return names;
  }
  function dayTotalCents(entry) {
    return Object.keys(entry || {}).reduce(function (a, n) {
      return a + Math.round(entry[n] * 100);
    }, 0);
  }

  function renderCalendar() {
    var body = $('#calendarBody');
    if (!body) return;
    var label = $('#calMonthLabel');
    var sel = parseDateStr(state.date) || new Date();
    var viewY = calYearMonth ? calYearMonth.y : sel.getFullYear();
    var viewM = calYearMonth ? calYearMonth.m : sel.getMonth();
    if (label) label.textContent = viewY + '년 ' + (viewM + 1) + '월';
    var hist = loadHistory();
    var firstDow = new Date(viewY, viewM, 1).getDay();
    var daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    var todayS = todayStr();
    var selS = fmtDateStr(sel);
    var html = '<div class="cal-grid">';
    DOW_LABELS.forEach(function (d, i) {
      html += '<div class="cal-dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + d + '</div>';
    });
    for (var b = 0; b < firstDow; b++) html += '<span class="cal-blank"></span>';
    for (var day = 1; day <= daysInMonth; day++) {
      var dObj = new Date(viewY, viewM, day);
      var ds = fmtDateStr(dObj);
      var entry = hist[ds];
      var has = entry && Object.keys(entry).length > 0;
      var cls = 'cal-day' + (dObj.getDay() === 0 ? ' sun' : dObj.getDay() === 6 ? ' sat' : '') +
        (has ? ' has-record' : '') + (ds === todayS ? ' is-today' : '') +
        (ds === selS ? ' is-selected' : '');
      html += '<button type="button" class="' + cls + '" data-cal-date="' + ds + '">' +
        '<span class="d-num">' + day + '</span>' +
        (has ? '<span class="d-total">$' +
          Math.round(dayTotalCents(entry) / 100).toLocaleString('en-US') + '</span>' : '') +
        '</button>';
    }
    html += '</div>';
    body.innerHTML = html;
    body.querySelectorAll('[data-cal-date]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectCalendarDate(btn.getAttribute('data-cal-date'));
      });
    });
    renderDayDetail(sel);
    var rangeEl = $('#payoutRangeLabel');
    if (rangeEl) {
      rangeEl.textContent = dayLabel(sel) + '부터 2주 (' + dayLabel(sel) + ' ~ ' +
        dayLabel(addDays(sel, 13)) + ')';
    }
  }

  // 달력에서 날짜를 고르면: 날짜가 바뀌면 입력은 비워지고(안전장치),
  // 그날 기록이 아래에 표시된다. 상단 날짜 칸의 "날짜 이동"(v11)과 달리
  // 달력은 둘러보기 용도라 입력이 따라가지 않는다.
  function selectCalendarDate(ds) {
    if (!ds) return;
    if (ds === state.date) { renderCalendar(); return; }
    // 달력 클릭은 기록 둘러보기·지급 시작일 고르기 용도라, 상단 날짜 칸의
    // "날짜 이동"(v11)과 달리 기존 동작(입력 비움)을 유지한다.
    state.date = ds;
    var di = $('#dateInput');
    if (di) di.value = ds;
    clearShiftInputs();
    inputsDirty = false;
    calYearMonth = null;
    hideDateMoveConfirm();
    save();
    renderAll();
  }

  function renderDayDetail(sel) {
    var box = $('#dayDetail');
    if (!box) return;
    var hist = loadHistory();
    var entry = hist[fmtDateStr(sel)];
    var title = '<p class="detail-title">' + dayLabel(sel) + ' (' +
      DOW_LABELS[sel.getDay()] + '요일)</p>';
    if (!entry || Object.keys(entry).length === 0) {
      box.innerHTML = title + '<p class="result-empty">기록이 없어요.</p>';
      return;
    }
    var html = title;
    sortedNames(entry).forEach(function (name) {
      html += '<div class="detail-row"><span class="detail-name">' + esc(name) + '</span>' +
        '<span class="detail-amt">' + fmt(Math.round(entry[name] * 100)) + '</span></div>';
    });
    html += '<div class="detail-row detail-total"><span class="detail-name">합계</span>' +
      '<span class="detail-amt">' + fmt(dayTotalCents(entry)) + '</span></div>';
    box.innerHTML = html;
  }

  function moveCalMonth(delta) {
    var sel = parseDateStr(state.date) || new Date();
    var y = calYearMonth ? calYearMonth.y : sel.getFullYear();
    var m = calYearMonth ? calYearMonth.m : sel.getMonth();
    var d = new Date(y, m + delta, 1);
    calYearMonth = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar();
  }

  // ---------- 팁 지급 (v7): 선택 날짜부터 2주(14일) ----------
  var currentPayout = null; // {startStr, endStr, csv, text, hasData}
  function computePayout() {
    var sel = parseDateStr(state.date) || new Date();
    var hist = loadHistory();
    var days = [];
    var perPerson = {};
    for (var i = 0; i < 14; i++) {
      var d = addDays(sel, i);
      var ds = fmtDateStr(d);
      var entry = hist[ds];
      if (entry && Object.keys(entry).length > 0) {
        var rows = sortedNames(entry).map(function (name) {
          var c = Math.round(entry[name] * 100);
          perPerson[name] = (perPerson[name] || 0) + c;
          return { name: name, cents: c };
        });
        days.push({ date: d, dateStr: ds, rows: rows, totalCents: dayTotalCents(entry) });
      }
    }
    var names = Object.keys(perPerson);
    names.sort(function (a, b) {
      var ia = rosterIndexOf(a);
      var ib = rosterIndexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return 0;
    });
    var grand = names.reduce(function (a, n) { return a + perPerson[n]; }, 0);
    return {
      start: sel, end: addDays(sel, 13),
      startStr: fmtDateStr(sel), endStr: fmtDateStr(addDays(sel, 13)),
      days: days, names: names, perPerson: perPerson, grandCents: grand,
    };
  }
  function csvCell(s) {
    s = String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function dollarsStr(c) { return (c / 100).toFixed(2); }
  function buildPayoutCsv(p) {
    var lines = [];
    lines.push('팁톡 팁 지급 내역');
    lines.push('기간,' + p.startStr + ' ~ ' + p.endStr);
    lines.push('이름,합계');
    p.names.forEach(function (n) {
      lines.push(csvCell(n) + ',' + dollarsStr(p.perPerson[n]));
    });
    lines.push('전체 총합,' + dollarsStr(p.grandCents));
    lines.push('');
    lines.push('날짜,이름,금액');
    p.days.forEach(function (d) {
      d.rows.forEach(function (r) {
        lines.push(d.dateStr + ',' + csvCell(r.name) + ',' + dollarsStr(r.cents));
      });
    });
    return lines.join('\n');
  }
  function buildPayoutText(p) {
    var lines = ['[팁 지급] ' + dayLabel(p.start) + ' ~ ' + dayLabel(p.end)];
    p.names.forEach(function (n) { lines.push(n + ' ' + fmt(p.perPerson[n])); });
    lines.push('전체 총합 ' + fmt(p.grandCents));
    return lines.join('\n');
  }
  function openPayout() {
    var p = computePayout();
    var csv = buildPayoutCsv(p);
    var text = buildPayoutText(p);
    currentPayout = {
      startStr: p.startStr, endStr: p.endStr,
      csv: csv, text: text, hasData: p.days.length > 0,
    };
    // 테스트·디버깅용으로 마지막 지급 내역을 노출한다.
    window.__tiptalkPayout = {
      start: p.startStr, end: p.endStr, csv: csv, text: text,
      grandCents: p.grandCents, perPerson: Object.assign({}, p.perPerson),
    };
    var html = '<h3>팁 지급 내역</h3>' +
      '<p class="payout-period">' + p.start.getFullYear() + '년 ' + dayLabel(p.start) +
      ' (' + DOW_LABELS[p.start.getDay()] + ') ~ ' + dayLabel(p.end) +
      ' (' + DOW_LABELS[p.end.getDay()] + ') · 2주</p>';
    if (p.days.length === 0) {
      html += '<p class="result-empty">이 기간에는 기록이 없어요.</p>';
    } else {
      p.names.forEach(function (n) {
        html += '<div class="grand-row"><span class="grand-name">' + esc(n) + '</span>' +
          '<span class="grand-amount">' + fmt(p.perPerson[n]) + '</span></div>';
      });
      html += '<div class="grand-row grand-total"><span class="grand-name">전체 총합</span>' +
        '<span class="grand-amount">' + fmt(p.grandCents) + '</span></div>';
      html += '<h4 class="payout-days-title">날짜별 내역</h4>';
      p.days.forEach(function (d) {
        html += '<div class="payout-day"><p class="payout-day-head">' + dayLabel(d.date) +
          ' (' + DOW_LABELS[d.date.getDay()] + ') — 합계 ' + fmt(d.totalCents) + '</p>' +
          '<p class="payout-day-names">' + d.rows.map(function (r) {
            return esc(r.name) + ' ' + fmt(r.cents);
          }).join(' · ') + '</p></div>';
      });
    }
    $('#payoutContent').innerHTML = html;
    $('#payoutCsvBtn').disabled = !currentPayout.hasData;
    $('#payoutCopyBtn').disabled = !currentPayout.hasData;
    $('#payoutModal').hidden = false;
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 무시 */ }
    ta.remove();
  }

  function renderAll() {
    renderRoster();
    renderShift('am');
    renderShift('pm');
    renderResults();
    renderCalendar();
  }

  // ---------- 전역 이벤트 ----------
  $('#rosterList').addEventListener('click', function (e) {
    var roleBtn = e.target.closest('[data-role-toggle]');
    var delBtn = e.target.closest('[data-delete-person]');
    if (roleBtn) {
      var p = personById(roleBtn.getAttribute('data-role-toggle'));
      if (p) {
        p.role = p.role === 'kitchen' ? 'server' : 'kitchen';
        inputsDirty = true; // 역할이 바뀌면 계산 결과가 달라지므로 기록도 갱신
        save();
        renderAll();
      }
    } else if (delBtn) {
      var target = personById(delBtn.getAttribute('data-delete-person'));
      if (target && window.confirm(target.name + ' 님을 명단에서 지울까요?')) {
        inputsDirty = true;
        state.roster = state.roster.filter(function (x) { return x.id !== target.id; });
        SHIFT_DEFS.forEach(function (d) {
          delete state.shifts[d.key].selected[target.id];
          if (state.shifts[d.key].suggested) delete state.shifts[d.key].suggested[target.id];
        });
        save();
        renderAll();
      }
    }
  });

  $('#addPersonForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var nameInput = $('#newName');
    var name = nameInput.value.trim();
    if (!name) return;
    var dupPerson = null;
    state.roster.forEach(function (p) {
      if (!dupPerson && (p.name === name || (p.aliases || []).indexOf(name) >= 0)) dupPerson = p;
    });
    if (dupPerson) {
      window.alert('이미 명단에 있는 사람이에요: ' + dupPerson.name);
      return;
    }
    state.roster.push({ id: uid(), name: name, role: $('#newRole').value, aliases: [] });
    nameInput.value = '';
    save();
    renderAll();
  });

  var dateInput = $('#dateInput');
  if (!state.date) state.date = todayStr();
  dateInput.value = state.date;
  // 날짜 변경 (v11):
  // - 입력이 있는 상태면 "날짜 이동" — 입력과 그 기록이 새 날짜로 따라간다
  //   (attemptDateChange 참고). 새 날짜에 다른 기록이 있으면 덮기 전에
  //   인라인 확인 바에서 확인받는다.
  // - 입력이 없으면 기존 안전장치 그대로: 입력을 비우고 inputsDirty를
  //   false로 둬서, 둘러보러 간 날짜의 기존 기록이 지워지거나 이전 날짜
  //   결과가 덮어씌워지지 않게 한다.
  dateInput.addEventListener('change', function () {
    var nd = dateInput.value;
    if (!nd) { dateInput.value = state.date; return; }
    // 같은 날짜면 아무것도 하지 않는다. 특히 덮어쓰기 확인 바가 떠 있는
    // 동안에는 바를 닫지 않는다 — 충돌 시 입력값이 원래 날짜로 되돌려진
    // 상태에서 change가 한 번 더 와도 확인이 사라지면 안 되기 때문이다.
    // (바는 [그대로 두기]·[옮기고 덮어쓰기]·달력 선택 등으로 닫힌다.)
    if (nd === state.date) return;
    attemptDateChange(nd);
  });

  // 날짜 이동 덮어쓰기 확인 바 (v11)
  $('#dateMoveYesBtn').addEventListener('click', function () {
    if (pendingDateMove) applyDateMove(pendingDateMove.newDate);
  });
  $('#dateMoveNoBtn').addEventListener('click', function () {
    hideDateMoveConfirm();
  });

  // 달력 월 이동 (v7)
  $('#calPrevBtn').addEventListener('click', function () { moveCalMonth(-1); });
  $('#calNextBtn').addEventListener('click', function () { moveCalMonth(1); });

  // 팁 지급 (v7): 내역 화면 + CSV 다운로드 + 텍스트 복사
  $('#payoutBtn').addEventListener('click', openPayout);
  $('#payoutCloseBtn').addEventListener('click', function () {
    $('#payoutModal').hidden = true;
  });
  $('#payoutModal').addEventListener('click', function (e) {
    if (e.target === this) this.hidden = true;
  });
  $('#payoutCsvBtn').addEventListener('click', function () {
    if (!currentPayout || !currentPayout.hasData) return;
    var blob = new Blob(['\uFEFF' + currentPayout.csv],
      { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tiptalk-payout-' + currentPayout.startStr + '_' +
      currentPayout.endStr + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $('#payoutCopyBtn').addEventListener('click', function () {
    if (!currentPayout || !currentPayout.hasData) return;
    var btn = this;
    function copied() {
      btn.textContent = '복사했어요 ✓';
      setTimeout(function () { btn.textContent = '텍스트 복사'; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentPayout.text).then(copied)
        .catch(function () { fallbackCopy(currentPayout.text); copied(); });
    } else {
      fallbackCopy(currentPayout.text);
      copied();
    }
  });

  $('#resetDayBtn').addEventListener('click', function () {
    if (!window.confirm('오늘 입력한 팁 금액과 선택한 사람을 지울까요? (명단은 그대로 둬요)')) return;
    clearShiftInputs();
    state.date = todayStr();
    dateInput.value = state.date;
    calYearMonth = null;
    hideDateMoveConfirm();
    inputsDirty = true; // 오늘 기록도 함께 지워지게 (총액 0 → 기록 삭제)
    save();
    renderAll();
  });

  save();
  renderAll();
})();
