'use strict';
/*
 * 팁 계산기 UI (뼈대 v1)
 * 기본 흐름: 팁 총액 입력 → 일한 사람 칩 선택 → 결과 확인 (3단계)
 * 시간·구간 입력은 접힌 고급 옵션 안에 있다.
 * 상태는 localStorage에 저장 (명단 + 마지막 선택 + 입력값). 백엔드 없음.
 * 계산은 전부 js/calc.js 의 순수 함수에 위임한다.
 */
(function () {
  var LS_KEY = 'tipcalc-v1';
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
    return { total: '', start: start, end: end, selected: sel, segAmounts: {}, advancedOpen: false };
  }
  function seedState() {
    return {
      date: todayStr(),
      roster: [
        { id: 'p-jiseon', name: '지선', role: 'server' },
        { id: 'p-sky', name: 'Sky', role: 'server' },
      ],
      shifts: {
        am: freshShift('11:00', '15:00', ['p-jiseon', 'p-sky']),
        pm: freshShift('16:00', '21:00', ['p-jiseon', 'p-sky']),
      },
    };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return seedState();
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.roster) || !s.shifts || !s.shifts.am || !s.shifts.pm) return seedState();
      return s;
    } catch (e) {
      return seedState();
    }
  }
  var state = loadState();
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 저장 실패 무시 */ }
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
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-chip="' + p.id + '">' +
        esc(p.name) +
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

    var needSegInput = result.incomplete && segs.length > 1;
    section.innerHTML =
      '<div class="shift-head"><h2>' + def.title + '</h2>' +
      '<span class="shift-time-label">' + esc(shift.start) + ' ~ ' + esc(shift.end) + '</span></div>' +
      '<div class="total-row"><label for="total-' + key + '">팁 총액</label>' +
      '<div class="money-wrap"><span class="dollar">$</span>' +
      '<input type="number" class="money-input" id="total-' + key + '" inputmode="decimal" min="0" step="0.01" ' +
      'placeholder="0.00" data-total-input value="' + esc(String(shift.total)) + '"></div></div>' +
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
      save();
      updateShiftWarnings(key, section);
      renderResults();
    });

    section.querySelectorAll('[data-chip]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-chip');
        if (shift.selected[id]) delete shift.selected[id];
        else shift.selected[id] = { start: '', end: '' };
        save();
        renderShift(key);
        renderResults();
      });
    });

    var advBtn = $('[data-advanced-toggle]', section);
    advBtn.addEventListener('click', function () {
      shift.advancedOpen = !shift.advancedOpen;
      save();
      renderShift(key);
    });

    section.querySelectorAll('[data-shift-time]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        shift[inp.getAttribute('data-shift-time')] = inp.value;
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
          save();
          renderShift(key);
          renderResults();
        }
      });
    });
    section.querySelectorAll('[data-seg-input]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        shift.segAmounts[inp.getAttribute('data-seg-input')] = inp.value;
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

  function renderAll() {
    renderRoster();
    renderShift('am');
    renderShift('pm');
    renderResults();
  }

  // ---------- 전역 이벤트 ----------
  $('#rosterList').addEventListener('click', function (e) {
    var roleBtn = e.target.closest('[data-role-toggle]');
    var delBtn = e.target.closest('[data-delete-person]');
    if (roleBtn) {
      var p = personById(roleBtn.getAttribute('data-role-toggle'));
      if (p) {
        p.role = p.role === 'kitchen' ? 'server' : 'kitchen';
        save();
        renderAll();
      }
    } else if (delBtn) {
      var target = personById(delBtn.getAttribute('data-delete-person'));
      if (target && window.confirm(target.name + ' 님을 명단에서 지울까요?')) {
        state.roster = state.roster.filter(function (x) { return x.id !== target.id; });
        SHIFT_DEFS.forEach(function (d) { delete state.shifts[d.key].selected[target.id]; });
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
    var dup = state.roster.some(function (p) { return p.name === name; });
    if (dup) {
      window.alert('같은 이름이 이미 있어요. 다른 이름으로 추가해 주세요.');
      return;
    }
    state.roster.push({ id: uid(), name: name, role: $('#newRole').value });
    nameInput.value = '';
    save();
    renderAll();
  });

  var dateInput = $('#dateInput');
  dateInput.value = state.date || todayStr();
  dateInput.addEventListener('change', function () {
    state.date = dateInput.value;
    save();
  });

  $('#resetDayBtn').addEventListener('click', function () {
    if (!window.confirm('오늘 입력한 팁 금액과 일한 시간을 지울까요? (명단과 선택한 사람은 그대로 둬요)')) return;
    SHIFT_DEFS.forEach(function (d) {
      var sh = state.shifts[d.key];
      sh.total = '';
      sh.segAmounts = {};
      Object.keys(sh.selected).forEach(function (id) {
        sh.selected[id] = { start: '', end: '' };
      });
    });
    state.date = todayStr();
    dateInput.value = state.date;
    save();
    renderAll();
  });

  save();
  renderAll();
})();
