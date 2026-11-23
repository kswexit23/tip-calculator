'use strict';
/*
 * 팁톡(TipTalk) v3 — 정산지 사진 판독 연동
 *
 * 흐름: 사진 선택 → Supabase Storage('tip-photos') 업로드 + tip_inbox 행 생성(pending)
 *       → 판독 데몬(tipcalc-autoread)이 결과를 채우면(done/error) id로 폴링해 수신
 *       → 앱이 팁 총액을 자동 입력하고, 손글씨 이름은 명단과 매칭해 "제안"으로만 표시.
 *
 * v9: 사진을 잘못 올렸을 때 지울 수 있게 cancelRow(행 취소)·deletePhotoFile
 * (스토리지 파일 삭제)을 추가하고, pollResult에 취소 콜백을 달았다.
 * 백엔드 정책은 add-v9-photo-delete.sql (anon update/delete 허용 + status
 * 'cancelled' 허용) — 없으면 취소 요청은 조용히 실패하고 앱은 그대로 동작한다.
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

  // 사진 업로드 + tip_inbox 행 생성. 만든 행 id와 스토리지 경로를 돌려준다
  // (v9: 사진 지우기에서 행 취소 + 파일 삭제에 둘 다 필요).
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
        return { id: rows[0].id, path: path };
      });
    });
  }

  function cancelledError() {
    var e = new Error('사진을 지웠어요');
    e.cancelled = true;
    return e;
  }

  // 행이 done/error가 될 때까지 폴링. onTick(경과 초) 콜백으로 진행 표시를 갱신한다.
  // isCancelled(선택): true를 돌려주면 폴링을 멈추고 cancelled 표시가 붙은
  // 에러로 reject한다 — 사용자가 사진을 지운 뒤 늦게 도착한 결과는 버려진다 (v9).
  function pollResult(id, onTick, isCancelled) {
    var started = Date.now();
    function cancelled() { return !!(isCancelled && isCancelled()); }
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (cancelled()) { reject(cancelledError()); return; }
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
          if (cancelled()) { reject(cancelledError()); return; }
          var row = rows && rows[0];
          if (row && (row.status === 'done' || row.status === 'error')) resolve(row);
          else setTimeout(tick, POLL_INTERVAL_MS);
        }).catch(function () {
          if (cancelled()) { reject(cancelledError()); return; }
          setTimeout(tick, POLL_INTERVAL_MS); // 일시적 네트워크 오류는 계속 폴링
        });
      })();
    });
  }

  // ---------- 사진 지우기 (v9): 백엔드 정리 (best-effort) ----------
  // 행을 status='cancelled'로 바꿔 데몬(status='pending'만 집어감)이 다시
  // 처리하지 않게 한다. anon UPDATE 정책 + status CHECK 확장은
  // add-v9-photo-delete.sql이 있어야 실제로 걸린다 — 정책이 아직 없어서
  // 실패해도(403 등) 앱 동작에는 영향 없게, 결과는 무시하고 항상 resolve한다.
  function cancelRow(id) {
    if (!id) return Promise.resolve(false);
    return fetch(SB_URL + '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ status: 'cancelled' }),
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // 스토리지의 사진 파일 삭제. 위와 같은 best-effort (정책은 add-v9-photo-delete.sql).
  function deletePhotoFile(path) {
    if (!path) return Promise.resolve(false);
    return fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'DELETE',
      headers: headers(),
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  window.TipPhoto = {
    decideShift: decideShift,
    matchNames: matchNames,
    prepareImage: prepareImage,
    uploadAndCreate: uploadAndCreate,
    pollResult: pollResult,
    cancelRow: cancelRow,
    deletePhotoFile: deletePhotoFile,
    _config: { SB_URL: SB_URL, BUCKET: BUCKET, TABLE: TABLE },
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.TipPhoto;
  }
})();
