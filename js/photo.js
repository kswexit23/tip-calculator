'use strict';
/*
 * 팁톡(TipTalk) v3 — 정산지 사진 판독 연동
 *
 * 흐름: 사진 선택 → Supabase Storage('tip-photos') 업로드 + tip_inbox 행 생성(pending)
 *       → 판독 데몬(tipcalc-autoread)이 결과를 채우면(done/error) id로 폴링해 수신
 *       → 앱이 팁 총액을 자동 입력하고, 손글씨 이름은 명단과 매칭해 "제안"으로만 표시.
 *
 * 로그인이 없는 앱이라 공개돼도 되는 anon(publishable) 키만 쓴다 — 데이터 보호는
 * tip_inbox / tip-photos 의 RLS가 담당한다 (add-v3-tip-inbox.sql).
 * 순수 함수(decideShift/matchNames)는 UI 없이 단위 테스트할 수 있게 분리했다.
 */
(function () {
  var SB_URL = 'https://jaysizdszykzvpmlyzmt.supabase.co';
  var ANON_KEY = 'sb_publishable_G32lpjwxN2lfMUw22438MQ_Np07ZBqC';
  var BUCKET = 'tip-photos';
  var TABLE = 'tip_inbox';
  var POLL_INTERVAL_MS = 3000;
  var POLL_TIMEOUT_MS = 120000;

  // ---------- 순수 함수 ----------

  // 정산 시각('YYYY-MM-DD HH:MM' 또는 'HH:MM')으로 시프트 판정.
  // 18:00 이전 = 'am'(점심 정산), 이후 = 'pm'(저녁 정산). 해석 불가면 null.
  function decideShift(settledTime) {
    if (!settledTime) return null;
    var m = String(settledTime).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    if (h > 23) return null;
    return h < 18 ? 'am' : 'pm';
  }

  // 읽은 이름 목록을 명단과 매칭. 이름/별칭이 정확히 같으면 매칭.
  // 반환: { matched: [{readName, personId, personName}], unmatched: [읽은 이름] }
  function matchNames(readNames, roster) {
    var matched = [];
    var unmatched = [];
    (readNames || []).forEach(function (raw) {
      var name = String(raw || '').trim();
      if (!name) return;
      var found = null;
      (roster || []).forEach(function (p) {
        if (found) return;
        if (p.name === name || (p.aliases || []).indexOf(name) >= 0) found = p;
      });
      if (found) {
        if (!matched.some(function (x) { return x.personId === found.id; })) {
          matched.push({ readName: name, personId: found.id, personName: found.name });
        }
      } else if (unmatched.indexOf(name) < 0) {
        unmatched.push(name);
      }
    });
    return { matched: matched, unmatched: unmatched };
  }

  // ---------- 이미지 준비 (쪼수 receipts.js와 같은 방식) ----------
  // jpeg/png는 긴 변 1600px로 줄여 JPEG로 변환. 변환 불가 포맷은 원본 그대로.
  function prepareImage(file) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png)$/.test(file.type)) { resolve(file); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        if (scale >= 1 && file.type === 'image/jpeg') { resolve(file); return; }
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  // ---------- Supabase REST ----------
  function headers(extra) {
    var h = { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  // 사진 업로드 + tip_inbox 행 생성. 만든 행 id를 돌려준다.
  function uploadAndCreate(file) {
    return prepareImage(file).then(function (prepared) {
      var path = 'uploads/' + Date.now() + '-' +
        Math.floor(Math.random() * 1e6).toString(36) + '.jpg';
      return fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }),
        body: prepared,
      }).then(function (r) {
        if (!r.ok) throw new Error('사진 업로드 실패 (' + r.status + ')');
        return fetch(SB_URL + '/rest/v1/' + TABLE, {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
          body: JSON.stringify({ image_path: path, status: 'pending' }),
        });
      }).then(function (r) {
        if (!r.ok) throw new Error('판독 요청 실패 (' + r.status + ')');
        return r.json();
      }).then(function (rows) {
        if (!rows || !rows[0] || !rows[0].id) throw new Error('판독 요청을 만들지 못했어요');
        return rows[0].id;
      });
    });
  }

  // 행이 done/error가 될 때까지 폴링. onTick(경과 초) 콜백으로 진행 표시를 갱신한다.
  function pollResult(id, onTick) {
    var started = Date.now();
    return new Promise(function (resolve, reject) {
      (function tick() {
        var elapsed = Math.floor((Date.now() - started) / 1000);
        if (onTick) onTick(elapsed);
        if (Date.now() - started > POLL_TIMEOUT_MS) {
          reject(new Error('판독이 너무 오래 걸려요. 잠시 뒤에 다시 해보거나 금액을 직접 입력해 주세요.'));
          return;
        }
        fetch(SB_URL + '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id) + '&select=*', {
          headers: headers(),
        }).then(function (r) {
          if (!r.ok) throw new Error('판독 결과 조회 실패 (' + r.status + ')');
          return r.json();
        }).then(function (rows) {
          var row = rows && rows[0];
          if (row && (row.status === 'done' || row.status === 'error')) resolve(row);
          else setTimeout(tick, POLL_INTERVAL_MS);
        }).catch(function () {
          setTimeout(tick, POLL_INTERVAL_MS); // 일시적 네트워크 오류는 계속 폴링
        });
      })();
    });
  }

  window.TipPhoto = {
    decideShift: decideShift,
    matchNames: matchNames,
    prepareImage: prepareImage,
    uploadAndCreate: uploadAndCreate,
    pollResult: pollResult,
    _config: { SB_URL: SB_URL, BUCKET: BUCKET, TABLE: TABLE },
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.TipPhoto;
  }
})();
