'use strict';
/*
 * 팁톡(TipTalk) UI (v4)
 * 기본 흐름: 팁 총액 입력 → 일한 사람 칩 선택 → 결과 확인 (3단계)
 * 시간·구간 입력은 접힌 고급 옵션 안에 있다.
 * v3: 시프트 카드의 "사진으로 채우기" — 정산지 사진을 올리면 판독 데몬이 읽어서
 *     팁 총액을 자동 입력하고, 손글씨 이름은 명단과 매칭해 "제안" 칩으로만 표시한다
 *     (확정은 사용자가 탭해야 한다). 사진 통신은 js/photo.js (TipPhoto)가 담당.
 * v4: 날짜별 인당 합계 자동 저장(localStorage 'tiptalk_history_v1') +
 *     맨 아래 "주급 정산표" (일요일~토요일 주 × 2주 + 인당 2주 토탈).
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
  function freshShift(start, end, selectedIds) {
    var sel = {};
    (selectedIds || []).forEach(function (id) { sel[id] = { start: '', end: '' }; });
    return {
      total: '', start: start, end: end, selected: sel, segAmounts: {}, advancedOpen: false,
      suggested: {},   // 사진 판독이 제안한 사람 {personId: 읽은 이름} — 확정은 사용자가 탭
      photoInfo: null, // 마지막 사진 판독 참고 정보 {purchase, tickets, time, fromOther, unmatched}
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
        am: freshShift('11:00', '15:00', ['p-jiseon', 'p-sky']),
        pm: freshShift('16:00', '21:00', ['p-jiseon', 'p-sky']),
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
        if (!s.shifts[k].suggested) s.shifts[k].suggested = {};
        if (s.shifts[k].photoInfo === undefined) s.shifts[k].photoInfo = null;
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
  // 주급 정산표 2주 윈도우 이동량 (0 = 선택 날짜 기준, ±1 = 2주씩 이동)
  var payrollOffset = 0;

  // 계산 결과를 현재 선택 날짜의 기록으로 반영한다.
  // - 총액 0 → 그 날짜 기록 삭제 (사용자가 입력을 비운 경우)
  // - 합계 검증 OK → 인당 합계로 저장 (이름 기준, 주방 포함 전 인원)
  // - 구간 미입력 등 미완성 상태 → 기존 기록을 건드리지 않는다
  function syncHistory(day) {
    if (!inputsDirty) return;
    var date = state.date;
    if (!date) return;
    var hist = loadHistory();
    var changed = false;
    if (day.totalCents === 0) {
      if (hist[date]) { delete hist[date]; changed = true; }
    } else if (day.balanced) {
      var entry = {};
      Object.keys(day.perPerson).forEach(function (id) {
        var p = personById(id);
        // 0원인 사람은 기록하지 않는다 (총액 0인 시프트에 선택만 돼 있어도
        // perPerson에 0으로 들어오기 때문 — 받은 팁이 있는 사람만 남긴다).
        if (p && day.perPerson[id] > 0) entry[p.name] = Math.round(day.perPerson[id]) / 100;
      });
      if (Object.keys(entry).length === 0) {
        if (hist[date]) { delete hist[date]; changed = true; }
      } else if (JSON.stringify(hist[date]) !== JSON.stringify(entry)) {
        hist[date] = entry;
        changed = true;
      }
    }
    if (changed) {
      saveHistory(hist);
      renderPayroll();
    }
  }

  // 두 시프트의 입력(금액·구간·시간·사진 정보)만 비운다. 명단 선택과
  // 시프트 기본 시간은 유지한다. 날짜 변경·사진 날짜 이동·입력 지우기가 공용.
  function clearShiftInputs() {
    SHIFT_DEFS.forEach(function (d) {
      var sh = state.shifts[d.key];
      sh.total = '';
      sh.segAmounts = {};
      sh.suggested = {};
      sh.photoInfo = null;
      Object.keys(sh.selected).forEach(function (id) {
        sh.selected[id] = { start: '', end: '' };
      });
    });
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
  function minLabel(m) {
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function segKey(s) { return s.startMin + '-' + s.endMin; }

  // ---------- 계산 연결 ----------
  function computeForShift(shift) {
    var kitchenIds = [];
    var workers = [];
    Object.keys(shift.selected).forEach(function (id) {
      var p = personById(id);
      if (!p) return;
      if (p.role === 'kitchen') {
        kitchenIds.push(id);
      } else {
        workers.push({
          id: id,
          startMin: TipCalc.timeToMin(shift.selected[id].start),
          endMin: TipCalc.timeToMin(shift.selected[id].end),
        });
      }
    });
    var segs = TipCalc.buildSegments(
      TipCalc.timeToMin(shift.start), TipCalc.timeToMin(shift.end), workers);
    var segInputs = segs.map(function (s) {
      var saved = shift.segAmounts[segKey(s)];
      return {
        startMin: s.startMin, endMin: s.endMin, memberIds: s.memberIds,
        amountCents: saved != null && saved !== '' ? TipCalc.toCents(saved) : null,
      };
    });
    var result = TipCalc.computeShift({
      totalCents: TipCalc.toCents(shift.total),
      kitchenIds: kitchenIds,
      segments: segInputs,
    });
    return { result: result, segments: result.segments };
  }

  // ---------- 사진 판독 (v3) ----------
  // 진행 상태는 저장하지 않는 화면 전용 상태 (렌더를 다시 해도 유지되게 렌더 밖에서 관리).
  var photoUi = { am: { busy: false, msg: '' }, pm: { busy: false, msg: '' } };

  function setPhotoStatus(key, msg) {
    photoUi[key].msg = msg;
    var section = document.getElementById('shift-' + key);
    var box = section ? section.querySelector('[data-photo-status]') : null;
    if (box) box.textContent = msg;
    var btn = section ? section.querySelector('[data-photo-btn]') : null;
    if (btn) btn.disabled = photoUi[key].busy;
  }

  // 판독 완료 행을 시프트에 반영: 팁 총액은 정산 시각으로 판정한 시프트에 넣고,
  // 손글씨 이름은 선택하지 않고 "제안"으로만 표시한다 (확정은 사용자 탭).
  // v4: 정산지 날짜가 현재 선택 날짜와 다르면 날짜를 그쪽으로 바꾸고 입력을
  // 비운 뒤 채운다 — 다른 날짜의 입력이 섞여 잘못 저장되는 것을 막는다.
  function applyPhotoResult(fromKey, row) {
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
      payrollOffset = 0;
    }
    inputsDirty = true;
    var targetKey = TipPhoto.decideShift(row.settled_time) || fromKey;
    var shift = state.shifts[targetKey];
    if (row.tip_amount != null) shift.total = String(row.tip_amount);
    var readNames = Array.isArray(row.names) ? row.names : [];
    var m = TipPhoto.matchNames(readNames, state.roster);
    if (!shift.suggested) shift.suggested = {};
    m.matched.forEach(function (x) {
      if (!shift.selected[x.personId]) shift.suggested[x.personId] = x.readName;
    });
    var rawTime = (row.raw && row.raw.time) ||
      (row.settled_time ? String(row.settled_time).slice(11) : '');
    shift.photoInfo = {
      purchase: row.purchase_amount != null ? row.purchase_amount : null,
      tickets: row.ticket_count != null ? row.ticket_count : null,
      time: rawTime,
      fromOther: targetKey !== fromKey ? fromKey : null,
      unmatched: m.unmatched,
    };
    save();
    photoUi[targetKey].busy = false;
    setPhotoStatus(targetKey, '✓ 판독 완료 — 금액과 사람이 맞는지 확인해 주세요.');
    renderShift(targetKey);
    if (targetKey !== fromKey) {
      photoUi[fromKey].busy = false;
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
    photoUi[key].busy = true;
    setPhotoStatus(key, '사진을 올리고 있어요…');
    TipPhoto.uploadAndCreate(file).then(function (id) {
      setPhotoStatus(key, '판독 중이에요…');
      return TipPhoto.pollResult(id, function (sec) {
        setPhotoStatus(key, '판독 중이에요… (' + sec + '초)');
      });
    }).then(function (row) {
      if (row.status === 'error') {
        photoUi[key].busy = false;
        setPhotoStatus(key, '⚠ ' + (row.error || '판독에 실패했어요. 사진을 다시 찍어주세요.'));
        return;
      }
      applyPhotoResult(key, row);
    }).catch(function (e) {
      photoUi[key].busy = false;
      setPhotoStatus(key, '⚠ ' + (e && e.message ? e.message : '사진을 처리하지 못했어요.'));
    });
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
  function renderShift(key) {
    var def = SHIFT_DEFS.filter(function (d) { return d.key === key; })[0];
    var shift = state.shifts[key];
    var section = $('#shift-' + key);
    var computed = computeForShift(shift);
    var result = computed.result;
    var segs = computed.segments;

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
      kitchenHtml = '<p class="kitchen-note">🍳 주방 ' + esc(kitchenNames.join(', ')) +
        ' — 팁 전체의 10%인 <span data-kitchen-amount>' + fmt(result.kitchenTotalCents) +
        '</span>를 먼저 나눠 가져요.</p>';
    }

    var advHtml = '';
    if (shift.advancedOpen) {
      advHtml += '<div class="advanced">';
      // 시프트 시간
      advHtml += '<div class="adv-block"><p class="adv-title">시프트 시간</p>' +
        '<div class="time-row">' +
          '<input type="time" data-shift-time="start" value="' + esc(shift.start) + '">' +
          '<span class="tilde">~</span>' +
          '<input type="time" data-shift-time="end" value="' + esc(shift.end) + '">' +
        '</div></div>';
      // 사람별 시간 (서버만)
      var selServers = Object.keys(shift.selected).filter(function (id) {
        var p = personById(id); return p && p.role === 'server';
      });
      if (selServers.length > 0) {
        advHtml += '<div class="adv-block"><p class="adv-title">사람별 일한 시간</p><div class="time-grid">';
        selServers.forEach(function (id) {
          var p = personById(id);
          var t = shift.selected[id];
          advHtml += '<div class="time-row">' +
            '<span class="who">' + esc(p.name) + '</span>' +
            '<input type="time" data-person-time="start" data-person-id="' + id + '" value="' + esc(t.start) + '">' +
            '<span class="tilde">~</span>' +
            '<input type="time" data-person-time="end" data-person-id="' + id + '" value="' + esc(t.end) + '">' +
          '</div>';
        });
        advHtml += '</div><p class="hint">시간을 비워두면 시프트 전체를 일한 것으로 봐요. 하루 종일 같이 일했으면 안 넣어도 돼요.</p></div>';
      }
      if (kitchenNames.length > 0) {
        advHtml += '<p class="hint">주방은 시간과 상관없이 전체 팁의 10%예요.</p>';
      }
      // 구간별 팁
      if (segs.length > 1) {
        advHtml += '<div class="adv-block"><p class="adv-title">구간별 팁 금액</p>' +
          '<p class="hint">시간대가 나뉘었어요. 각 구간의 실제 팁 합계를 체크(영수증)를 보고 넣어주세요. 마지막 구간은 나머지로 자동 계산돼요.</p>';
        segs.forEach(function (s) {
          var who = s.memberIds.map(function (id) {
            var p = personById(id); return p ? p.name : '?';
          }).join(', ');
          advHtml += '<div class="seg-row"><div class="seg-info">' +
            '<div class="seg-when">' + minLabel(s.startMin) + ' ~ ' + minLabel(s.endMin) + '</div>' +
            '<div class="seg-who">' + esc(who) + '</div></div>';
          if (s.auto) {
            advHtml += '<div><div class="seg-auto-label">나머지 자동</div>' +
              '<div class="seg-auto" data-auto-amount>' + fmt(s.amountCents) + '</div></div>';
          } else {
            var savedVal = shift.segAmounts[segKey(s)];
            advHtml += '<div class="money-wrap"><span class="dollar">$</span>' +
              '<input type="number" class="money-input" inputmode="decimal" min="0" step="0.01" ' +
              'placeholder="0.00" data-seg-input="' + segKey(s) + '" value="' +
              (savedVal == null ? '' : esc(String(savedVal))) + '"></div>';
          }
          advHtml += '</div>';
        });
        advHtml += '</div>';
      } else if (segs.length === 1) {
        advHtml += '<p class="hint">지금은 구간이 하나예요. 같은 시간에 같이 일했으면 이대로 두면 돼요.</p>';
      }
      advHtml += '</div>';
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

    var needSegInput = result.incomplete && segs.length > 1;
    section.innerHTML =
      '<div class="shift-head"><h2>' + def.title + '</h2>' +
      '<span class="shift-time-label">' + esc(shift.start) + ' ~ ' + esc(shift.end) + '</span></div>' +
      '<div class="total-row"><label for="total-' + key + '">팁 총액</label>' +
      '<div class="money-wrap"><span class="dollar">$</span>' +
      '<input type="number" class="money-input" id="total-' + key + '" inputmode="decimal" min="0" step="0.01" ' +
      'placeholder="0.00" data-total-input value="' + esc(String(shift.total)) + '"></div></div>' +
      '<div class="photo-row">' +
      '<button type="button" class="btn photo-btn" data-photo-btn' +
        (photoUi[key].busy ? ' disabled' : '') + '>📷 사진으로 채우기</button>' +
      '<input type="file" accept="image/*" class="photo-input" data-photo-input hidden>' +
      '</div>' +
      '<div class="photo-status" data-photo-status>' + esc(photoUi[key].msg) + '</div>' +
      photoInfoHtml +
      '<p class="chips-label">일한 사람 (눌러서 선택)</p>' +
      '<div class="chips">' + chipsHtml + '</div>' +
      kitchenHtml +
      '<button type="button" class="btn advanced-toggle" data-advanced-toggle>' +
        (shift.advancedOpen ? '시간 나누기 닫기' : '일한 시간이 서로 다르면 눌러주세요') +
        (needSegInput ? ' · 구간 팁 입력 필요' : '') +
      '</button>' +
      advHtml +
      '<div class="shift-warnings" data-warnings></div>';

    attachShiftListeners(key, section);
    updateShiftWarnings(key, section);
  }

  function updateShiftWarnings(key, section) {
    var shift = state.shifts[key];
    var result = computeForShift(shift).result;
    var box = $('[data-warnings]', section);
    if (box) {
      box.innerHTML = result.warnings.map(function (w) {
        return '<div class="warning">⚠ ' + esc(w) + '</div>';
      }).join('');
    }
    var kAmt = $('[data-kitchen-amount]', section);
    if (kAmt) kAmt.textContent = fmt(result.kitchenTotalCents);
    var auto = $('[data-auto-amount]', section);
    if (auto && result.segments.length > 1) {
      auto.textContent = fmt(result.segments[result.segments.length - 1].amountCents);
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
        else shift.selected[id] = { start: '', end: '' };
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

    var advBtn = $('[data-advanced-toggle]', section);
    advBtn.addEventListener('click', function () {
      shift.advancedOpen = !shift.advancedOpen;
      save();
      renderShift(key);
    });

    section.querySelectorAll('[data-shift-time]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        shift[inp.getAttribute('data-shift-time')] = inp.value;
        inputsDirty = true;
        save();
        renderShift(key);
        renderResults();
      });
    });
    section.querySelectorAll('[data-person-time]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var id = inp.getAttribute('data-person-id');
        if (shift.selected[id]) {
          shift.selected[id][inp.getAttribute('data-person-time')] = inp.value;
          inputsDirty = true;
          save();
          renderShift(key);
          renderResults();
        }
      });
    });
    section.querySelectorAll('[data-seg-input]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        shift.segAmounts[inp.getAttribute('data-seg-input')] = inp.value;
        inputsDirty = true;
        save();
        updateShiftWarnings(key, section);
        renderResults();
      });
    });
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
      '<th>이름</th><th>오전</th><th>오후</th><th>합계</th></tr></thead><tbody>';
    rows.forEach(function (p) {
      // 총액이 0인 시프트는 나눈 금액이 없으므로 '–'로 표시
      var amVal = amRes.totalCents === 0 ? null : amRes.perPerson[p.id];
      var pmVal = pmRes.totalCents === 0 ? null : pmRes.perPerson[p.id];
      html += '<tr><td class="p-name">' + esc(p.name) +
        (p.role === 'kitchen' ? ' <span class="role-badge kitchen">주방</span>' : '') + '</td>' +
        '<td>' + fmt(amVal) + '</td>' +
        '<td>' + fmt(pmVal) + '</td>' +
        '<td class="p-total">' + fmt(day.perPerson[p.id]) + '</td></tr>';
    });
    html += '</tbody><tfoot><tr><td>전체</td><td>' + fmt(amRes.totalCents) + '</td><td>' +
      fmt(pmRes.totalCents) + '</td><td>' + fmt(day.totalCents) + '</td></tr></tfoot></table>';

    if (day.balanced) {
      html += '<div class="verify ok">✓ 합계가 맞아요 — 총 ' + fmt(day.totalCents) +
        '가 빠짐없이 나뉘었어요.</div>';
    } else {
      html += '<div class="verify bad">⚠ 아직 합계가 안 맞아요 — 입력한 팁 ' + fmt(day.totalCents) +
        ' / 나뉜 금액 ' + fmt(day.distributedCents) + '</div>';
    }

    var warns = [];
    amRes.warnings.forEach(function (w) { warns.push('오전: ' + w); });
    pmRes.warnings.forEach(function (w) { warns.push('오후: ' + w); });
    if (warns.length > 0) {
      html += '<div class="result-warnings">' + warns.map(function (w) {
        return '<div class="warning">⚠ ' + esc(w) + '</div>';
      }).join('') + '</div>';
    }
    body.innerHTML = html;
  }

  // ---------- 주급 정산표 렌더 (v4) ----------
  // 주는 일요일 시작 ~ 토요일 끝. 윈도우 = 선택 날짜가 속한 주 + 그 전주.
  var DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
  function rosterIndexOf(name) {
    for (var i = 0; i < state.roster.length; i++) {
      if (state.roster[i].name === name) return i;
    }
    return -1;
  }
  function renderPayroll() {
    var body = $('#payrollBody');
    if (!body) return;
    var rangeEl = $('#payrollRange');
    var hist = loadHistory();
    var anchor = parseDateStr(state.date) || new Date();
    var winStart = addDays(sundayOf(anchor), -7 + payrollOffset * 14);
    var winEnd = addDays(winStart, 13);
    if (rangeEl) {
      rangeEl.textContent = dayLabel(winStart) + '(일) ~ ' + dayLabel(winEnd) + '(토)';
    }
    var days = [];
    for (var i = 0; i < 14; i++) days.push(addDays(winStart, i));

    // 이 2주 기록에 등장하는 인원 수집 (명단 순서 우선, 나머지는 첫 등장 순)
    var seen = {};
    var names = [];
    days.forEach(function (d) {
      var e = hist[fmtDateStr(d)];
      if (e) Object.keys(e).forEach(function (n) {
        if (!seen[n]) { seen[n] = true; names.push(n); }
      });
    });
    names.sort(function (a, b) {
      var ia = rosterIndexOf(a);
      var ib = rosterIndexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return 0;
    });

    if (names.length === 0) {
      body.innerHTML = '<p class="result-empty">이 2주에는 저장된 정산 기록이 없어요. ' +
        '날짜를 골라 팁 정산을 하면 여기에 자동으로 쌓여요.</p>';
      return;
    }

    function centsOf(dateStr, name) {
      var e = hist[dateStr];
      if (!e || e[name] == null) return null;
      return Math.round(e[name] * 100);
    }

    var html = '';
    var twoWeek = {};
    for (var w = 0; w < 2; w++) {
      var wDays = days.slice(w * 7, w * 7 + 7);
      html += '<div class="payroll-week"><p class="payroll-week-label">' +
        dayLabel(wDays[0]) + '(일) ~ ' + dayLabel(wDays[6]) + '(토)</p>';
      html += '<div class="payroll-scroll"><table class="payroll"><thead><tr><th>이름</th>';
      wDays.forEach(function (d) {
        html += '<th>' + DOW_LABELS[d.getDay()] +
          '<span class="dow-date">' + (d.getMonth() + 1) + '/' + d.getDate() + '</span></th>';
      });
      html += '<th>주 합계</th></tr></thead><tbody>';
      names.forEach(function (name) {
        var wSum = 0;
        var has = false;
        html += '<tr><td class="p-name">' + esc(name) + '</td>';
        wDays.forEach(function (d) {
          var c = centsOf(fmtDateStr(d), name);
          if (c == null) {
            html += '<td class="no-rec">–</td>';
          } else {
            html += '<td>' + fmt(c) + '</td>';
            wSum += c;
            has = true;
          }
        });
        html += '<td class="p-week-total">' + (has ? fmt(wSum) : '–') + '</td></tr>';
        twoWeek[name] = (twoWeek[name] || 0) + wSum;
      });
      html += '</tbody></table></div></div>';
    }

    var grand = 0;
    html += '<div class="payroll-grand"><h3>2주 토탈</h3>';
    names.forEach(function (name) {
      grand += twoWeek[name] || 0;
      html += '<div class="grand-row"><span class="grand-name">' + esc(name) + '</span>' +
        '<span class="grand-amount">' + fmt(twoWeek[name] || 0) + '</span></div>';
    });
    html += '<div class="grand-row grand-total"><span class="grand-name">전체 총합</span>' +
      '<span class="grand-amount">' + fmt(grand) + '</span></div></div>';
    body.innerHTML = html;
  }

  function renderAll() {
    renderRoster();
    renderShift('am');
    renderShift('pm');
    renderResults();
    renderPayroll();
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
  // 날짜 변경 안전장치: 날짜만 바꾸면 입력 총액을 비우고(명단 선택은 유지),
  // inputsDirty를 false로 둬서 이전 날짜의 결과가 새 날짜에 덮어씌워지거나
  // 새 날짜의 기존 기록이 지워지지 않게 한다. 사용자가 실제로 입력하면
  // 그때부터 그 날짜의 기록으로 저장된다.
  dateInput.addEventListener('change', function () {
    var nd = dateInput.value;
    if (!nd) { dateInput.value = state.date; return; }
    if (nd === state.date) return;
    state.date = nd;
    clearShiftInputs();
    inputsDirty = false;
    payrollOffset = 0;
    save();
    renderAll();
  });

  $('#payPrevBtn').addEventListener('click', function () {
    payrollOffset -= 1;
    renderPayroll();
  });
  $('#payNextBtn').addEventListener('click', function () {
    payrollOffset += 1;
    renderPayroll();
  });

  $('#resetDayBtn').addEventListener('click', function () {
    if (!window.confirm('오늘 입력한 팁 금액과 일한 시간을 지울까요? (명단과 선택한 사람은 그대로 둬요)')) return;
    clearShiftInputs();
    state.date = todayStr();
    dateInput.value = state.date;
    payrollOffset = 0;
    inputsDirty = true; // 오늘 기록도 함께 지워지게 (총액 0 → 기록 삭제)
    save();
    renderAll();
  });

  save();
  renderAll();
})();
