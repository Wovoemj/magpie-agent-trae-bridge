(function () {
  var live = null;
  var lastState = null;
  var lastErr = '';

  function el(id) { return document.getElementById(id); }
  function text(id, v) { var n = el(id); if (n && n.textContent !== v) n.textContent = v; }

  function pill(ok, label) {
    var p = el('pill');
    p.classList.toggle('on', ok === true);
    p.classList.toggle('off', ok === false);
    text('pillText', label);
  }

  function fmtAt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function render(d) {
    live = d;
    var c = d.checkin || {};
    var signed = c.lastDay && c.lastDay === d.today;
    pill(d.ok === true, d.ok === true ? '守护进程在线' : '守护进程没应答');

    text('state', signed ? '今天已经签到了' : '今天还没签到');
    text('day', d.today || '');
    text('enabled', c.enabled === false ? '关闭' : '开启');
    text('at', c.at || '—');
    text('clients', d.health && typeof d.health.clients === 'number' ? String(d.health.clients) : '—');

    var r = c.lastResult;
    if (r) {
      var bits = [fmtAt(r.at) + ' · ' + (r.action || 'status')];
      if (r.via === 'api') bits.push('接口');
      else if (r.via === 'trae') bits.push('窗口');
      if (r.credits != null) bits.push('积分 ' + r.credits);
      if (r.claimed === true) bits.push('已领取');
      else if (r.checkedIn === true) bits.push('今天已签过');
      else if (r.ok === false) bits.push('失败');
      if (r.message) bits.push(String(r.message).slice(0, 120));
      text('note', '上次：' + bits.join(' · '));
    } else if (d.ok === false) {
      text('note', d.error ? String(d.error) : '守护进程没应答 —— 先跑 trae-magpie serve');
    } else {
      text('note', '还没有记录：点「立即签到」，或者等时间点到了让它自己试。');
    }

    var m = d.magpie;
    if (m) {
      var s = (m.day || '') + ' ' + (m.outcome || '');
      if (m.credit != null) s += ' · ' + m.credit;
      text('native', s.trim());
    } else {
      text('native', '没有记录');
    }

    var a = d.auth || {};
    if (a.signedIn) {
      var who = a.account && (a.account.name || a.account.uid) ? (a.account.name || a.account.uid) : "已登录";
      text("acct", who + (a.source === "magpie" ? "（来自 Magpie）" : ""));
      el("account").textContent = "退出登录";
    } else {
      text("acct", a.pending ? "等浏览器登录…" : "没登录");
      el("account").textContent = "浏览器登录";
    }

    var on = c.enabled !== false;
    el('toggle').textContent = on ? '关掉自动签到' : '开启自动签到';
    if (c.at && document.activeElement !== el('time')) el('time').value = c.at;
  }

  function renderError(msg) {
    lastErr = msg || 'no data';
    pill(false, '宿主还没写好数据');
    text('note', msg || '等 page/live.js —— Magpie 的插件宿主没跑起来时不会有它。');
  }

  // One look at what this frame can actually do, left in the plugin's options so
  // a person (or an agent) can read it from plugins.json without devtools.
  function diag() {
    var api = window.magpie;
    var payload = {
      at: Date.now(),
      href: String(location.href),
      ready: document.readyState,
      magpie: typeof api,
      options: !!(api && api.options),
      live: typeof window.MagpieTraeCheckinLive,
      err: lastErr || ''
    };
    if (!api || !api.options) return;
    api.options.get().then(function (cur) {
      cur = cur || {};
      var old = cur.pageDiag;
      if (old && old.href === payload.href && old.ready === payload.ready && old.magpie === payload.magpie && old.options === payload.options && old.live === payload.live && old.err === payload.err) return;
      cur.pageDiag = payload;
      return api.options.set(cur);
    }).catch(function () {});
  }

  function poll() {
    var s = document.createElement('script');
    s.src = 'live.js?t=' + Date.now();
    s.onload = function () {
      s.remove();
      if (window.MagpieTraeCheckinLive) render(window.MagpieTraeCheckinLive);
      else renderError('live.js 里没有数据');
    };
    s.onerror = function () { s.remove(); renderError('还读不到 page/live.js'); };
    document.head.appendChild(s);
  }

  function request(patch) {
    var api = window.magpie;
    if (!api || !api.options) return renderError('bridge.js 没加载，改不了设置');
    var btns = document.querySelectorAll('button, input');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    api.options.get().then(function (cur) {
      var next = Object.assign({}, cur || {});
      next.checkinRequest = Object.assign({ at: Date.now() }, patch);
      return api.options.set(next);
    }).then(function () {
      pill(true, '已提交给 Magpie，正在重载插件宿主…');
    }).catch(function (e) {
      renderError('提交失败：' + (e && e.message ? e.message : String(e)));
    }).then(function () {
      setTimeout(function () {
        Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      }, 1600);
    });
  }

  el('run').addEventListener('click', function () { request({ kind: 'run' }); });
  el('account').addEventListener('click', function () {
    var signed = !!(live && live.auth && live.auth.signedIn);
    request({ kind: signed ? 'logout' : 'login' });
  });
  el('toggle').addEventListener('click', function () {
    var cur = live && live.checkin ? live.checkin.enabled !== false : true;
    request({ kind: 'config', enabled: !cur });
  });
  el('save').addEventListener('click', function () {
    var v = (el('time').value || '').trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) {
      renderError('时间要写成 HH:MM，例如 09:00');
      return;
    }
    request({ kind: 'config', time: v.length === 4 ? '0' + v : v });
  });

  poll();
  setInterval(poll, 2000);
  // Writing plugin options makes magpie rewrite plugins.json and restart the host, so this
  // self-report only runs when asked for: open the page with ?diag=1 appended.
  if (/[?&]diag=1/.test(location.search)) setTimeout(diag, 3000);

  if (window.magpie && window.magpie.ready) {
    window.magpie.ready.catch(function () {});
  }
})();
