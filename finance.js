/* ============================================================
   財務作業（finance.js）
   會計的「付款批次」五個步驟、放行人的「待放行」、兩種角色都能用的「單據完備」。

   app.js 在網址是 #finance/ops/... 時呼叫 FinanceOps.show(rest)，rest 是 ops 後面的路徑：
     []                               依角色決定預設頁（有待放行的批次→待放行；會計→付款批次；其他→單據完備）
     ['batches']                      ① 選批次
     ['pay', '2026-11-05']            ② 核對清單（還沒送出，用付款日當代號）
     ['pay', '2026-11-05', 'send']    ③ 匯入兆豐、送出放行（送出前）
     ['batch', 'B20261105-153012']    已送出的批次，依狀態顯示 ③ 等放行／④ 確認已付款／⑤ 記到藍途
     ['release']                      待放行（只有一批時直接打開那一批）
     ['release', 'B20261105-153012']  待放行：某一批
     ['completeness']                 單據完備
   畫面全部畫在 #opsRoot；樣式在 finance.css（class 一律 fo- 開頭）。
   後端介面見 API-CONTRACT 第 4 節；權限後端每個動作都會再檢查，這裡只是把按鈕停用、說明原因。
   兆豐匯入檔、藍途匯入檔、憑證 ZIP 都在瀏覽器裡產生（SheetJS、JSZip 用到時才載入）。
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- 常數 ---------------- */
  const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const FIN_CHANNEL = "#team-組織發展中心";
  const ANNOUNCE_CHANNEL = "#組織布告欄-組織事項宣布用";
  const APP_NAME = "團隊後台";
  const RELEASER = "偉翔";   // 文案裡的放行人；實際是誰放行以批次上的 releasedByName 為準
  const ACCOUNTANT = "禎瑩"; // 文案裡的會計；實際以批次上的 sentByName 為準
  const IMPORT_MAX_ROWS = 250;              // 藍途一次最多匯入 250 筆
  const ATTACH_LIMIT = 5 * 1024 * 1024;     // 藍途附件上限 5 MB
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const GROUPS = ["reimb", "transfer", "bill"];
  const GROUP_NAME = { reimb: "代墊款", transfer: "匯款", bill: "繳費單" };
  const TYPE_DESC = {
    "5號": "代墊款（跟薪資一起匯）、每月固定支出、繳費單。",
    "20號": "匯款給廠商和外部個人的款項。",
    "臨時": "臨時加開的付款批次。",
  };
  const NEXT_LABEL = { "待放行": "看放行狀態", "已放行": "繼續：確認已付款", "已付款": "繼續：記到藍途" };
  const HOLD_CHIPS = [
    { label: "帳號待確認", text: "帳號待確認：請確認收款帳號，下一批再付。" },
    { label: "金額有疑問", text: "金額有疑問：請說明金額，下一批再付。" },
    { label: "延到下一批", text: "這次先不付，延到下一批。" },
  ];
  const IMPORT_HEADER = ["收付日期", "憑證日期", "付款金額", "收款金額", "附註說明", "會計項目代碼", "營業稅", "手續費", "發票號碼", "對象", "標籤1", "標籤2", "標籤3", "標籤4", "標籤5"];
  const BANK_HEADER = ["序號", "收款銀行代碼（7碼）", "收款帳號", "收款戶名", "金額", "附言", "提交人", "紀錄ID"];
  const REIMB_HEADER = ["序號", "姓名", "代墊款合計", "筆數", "明細"];
  const MIME_EXT = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "image/heic": "heic", "image/heif": "heif", "image/tiff": "tif", "application/pdf": "pdf",
  };
  const ICON_CHECK = '<svg class="fo-ico" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="10" fill="currentColor"/><path d="M5 10.1 6.4 8.7 8.5 10.8 13.6 5.7 15 7.1 8.5 13.6Z" fill="#fff"/></svg>';
  const ICON_TICK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M2.5 8.5 6 12l7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_FILE = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill="#fff" stroke="#7f939b" stroke-width="1.5"/><path d="M14 2v5h5" fill="none" stroke="#7f939b" stroke-width="1.5"/><path d="M8 12h8M8 15.5h8M8 19h5" stroke="#b9c7cd" stroke-width="1.5" stroke-linecap="round"/></svg>';

  /* ---------------- 畫面狀態 ---------------- */
  const S = {
    token: 0,          // 每次換頁 +1；非同步回來時比對，舊畫面的回應不會蓋掉新畫面
    route: { page: "", section: "" },
    view: null,        // 目前畫面的重畫函式（狀態改變時呼叫）
    overview: null,
    overviewAt: 0,
    drafts: {},        // payDate → 第 2、3 步的草稿（勾選、薪資總額、兆豐檔）
    batches: {},       // batchId → { batch, records }（records 已照付款順序排好）
    ui: {},            // batchId → 這一批畫面上的暫存（實際匯出日期、打勾、ZIP 進度…）
    confirmed: {},     // batchId → financeConfirmPaid 的回應（posted、warnings）
    rel: null,         // 待放行：{ batchId, held, confirmed, returnOpen, returnReason }
    relResult: null,   // 剛放行／退回的結果（顯示在待放行頁最上面）
    comp: { records: null, filter: "todo", open: {}, notes: {}, pinned: {}, busy: {}, err: {} },
    busy: "",          // 正在進行的動作（避免連按）
    err: null,         // { where, text }：動作失敗的訊息，畫在那個動作旁邊
    retry: null,
    lastFk: null,      // 最後按的元素（處理中被停用、焦點掉了的話，畫完放回去）
    recentOpen: false,
    otherDate: "",
  };

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function toInt(s) { const n = parseInt(String(s == null ? "" : s).replace(/[^0-9]/g, ""), 10); return isFinite(n) ? n : 0; }
  function fmtNum(n) { return num(n).toLocaleString("en-US"); }
  function money(n) { return "NT$ " + fmtNum(n); }
  function sum(list) { return list.reduce((t, r) => t + num(r.amount), 0); }
  function cut(s, n) { return Array.from(String(s == null ? "" : s)).slice(0, n).join(""); }
  function uniq(list) { const out = []; list.forEach((x) => { if (x && out.indexOf(x) < 0) out.push(x); }); return out; }
  function endPunct(s) { const t = String(s || "").trim(); return !t || /[。！？.!?]$/.test(t) ? t : t + "。"; }
  function dateParts(d) { return /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); }
  function md(d) { const m = dateParts(d); return m ? (+m[2]) + "/" + (+m[3]) : String(d || ""); }
  function mdhm(t) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(t || ""));
    return m ? (+m[2]) + "/" + (+m[3]) + " " + m[4] + ":" + m[5] : md(t);
  }
  function ymd(d) { const m = dateParts(d); return m ? m[1] + m[2] + m[3] : ""; }
  function dayNum(d) { const m = dateParts(d); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; }
  function taipeiParts() {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        .formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    } catch (e) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return { year: String(d.getFullYear()), month: p(d.getMonth() + 1), day: p(d.getDate()), hour: p(d.getHours()), minute: p(d.getMinutes()) };
    }
  }
  function todayStr() { const p = taipeiParts(); return p.year + "-" + p.month + "-" + p.day; }
  function nowHM() { const p = taipeiParts(); return String(p.hour).replace(/^24$/, "00") + ":" + p.minute; }
  function shortName(name) {
    // 黃偉翔 → 偉翔：跟 Slack 上大家互相稱呼的方式一樣
    const s = String(name || "").trim();
    return /^[\u4e00-\u9fff]{3,4}$/.test(s) ? s.slice(-2) : s;
  }
  function batchLabel(payDate, type) { return md(payDate) + (type === "臨時" ? " 臨時批次" : " 批次"); }
  function fmtBranch(b) {
    const v = String(b || "").replace(/\D/g, "");
    return v.length === 7 ? v.slice(0, 3) + "-" + v.slice(3) : String(b || "");
  }
  function digitsText(v) { return String(v == null ? "" : v).replace(/[\s-]/g, ""); }
  function groupDigits(s) {
    // 每 4 碼留一點間距方便對照；間距是 CSS 做的，複製出去不會多出空白
    const v = String(s || "").replace(/\s+/g, "");
    if (!v) return "—";
    return (v.match(/.{1,4}/g) || [v]).map((p) => '<span class="fo-grp">' + esc(p) + "</span>").join("");
  }
  function extOf(name, mime) {
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || "").trim());
    if (m) return m[1].toLowerCase();
    const t = String(mime || "").toLowerCase().split(";")[0].trim();
    if (MIME_EXT[t]) return MIME_EXT[t];
    return "";
  }
  function safeName(s) {
    const t = String(s || "").replace(/[\\/:*?"<>|]/g, "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
    return cut(t, 20).trim() || "單據";
  }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : ""; }
  function fmtSize(bytes) {
    if (bytes == null || !isFinite(bytes)) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }
  function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
  function b64ToBytes(b64) {
    const s = String(b64 || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- 登入者與角色 ---------------- */
  function me() { try { return (typeof currentUser !== "undefined" && currentUser) || null; } catch (e) { return null; } }
  function roles() { const u = me(); return u && Array.isArray(u.financeRoles) ? u.financeRoles : []; }
  function isAccountant() { return roles().indexOf("會計") >= 0; }
  function isReleaser() { return roles().indexOf("放行") >= 0; }
  function isOwn(b) {
    const u = me();
    return !!(u && u.email && b && b.sentBy && String(b.sentBy).toLowerCase() === String(u.email).toLowerCase());
  }

  /* ---------------- 單據整理 ---------------- */
  function normRecord(r) {
    const x = Object.assign({}, r);
    if (GROUPS.indexOf(x.group) < 0) x.group = "transfer";
    x.amount = num(x.amount);
    x.id = String(x.id == null ? "" : x.id);
    return x;
  }
  function personOf(r) { return r.person || r.payee || r.uploader || "（沒有填人名）"; }
  // 付款順序（第 2 步的顯示、匯入檔的列、憑證檔名的編號都照這個）：代墊款（照人分組）→ 匯款 → 繳費單
  function orderRecords(list) {
    const all = arr(list).filter(Boolean).map(normRecord);
    const reimb = all.filter((r) => r.group === "reimb");
    const out = [];
    uniq(reimb.map(personOf)).forEach((n) => reimb.forEach((r) => { if (personOf(r) === n) out.push(r); }));
    all.forEach((r) => { if (r.group === "transfer") out.push(r); });
    all.forEach((r) => { if (r.group === "bill") out.push(r); });
    return out;
  }
  function orderBatchRecords(b, records) {
    const ids = arr(b && b.recordIds).map(String);
    const list = arr(records).filter(Boolean).slice();
    if (ids.length) list.sort((x, y) => { const a = ids.indexOf(String(x.id)); const c = ids.indexOf(String(y.id)); return (a < 0 ? 1e9 : a) - (c < 0 ? 1e9 : c); });
    return orderRecords(list);
  }
  function groupOf(list) {
    const g = { reimb: [], transfer: [], bill: [] };
    list.forEach((r) => { (g[r.group] || g.transfer).push(r); });
    return g;
  }
  function people(list) {
    return uniq(list.map(personOf)).map((name) => ({ name, items: list.filter((r) => personOf(r) === name) }));
  }
  function heldMap(b) { return b && b.held && typeof b.held === "object" ? b.held : {}; }
  function paidRecords(b, records) {
    const ids = arr(b.recordIds).map(String);
    const held = heldMap(b);
    return records.filter((r) => (!ids.length || ids.indexOf(r.id) >= 0) && !has(held, r.id));
  }
  function heldRecords(b, records) { const held = heldMap(b); return records.filter((r) => has(held, r.id)); }
  function recordLine(r) {
    const who = r.group === "reimb" ? personOf(r) : (r.payee || r.vendor || "");
    return who + "｜" + (r.purpose || "") + "｜" + money(r.amount) + "（提交人 " + (r.uploader || personOf(r)) + "）";
  }
  function importRows(paid) {
    return paid.map((r, i) => ({ r, no: i + 1, nn: String(i + 1).padStart(2, "0") }));
  }
  function zipEntryName(x, f) {
    const r = x.r;
    const parts = [x.nn];
    const d = ymd(r.invoiceDate);
    if (d) parts.push(d);
    parts.push(num(r.amount) + "元");
    parts.push(safeName(r.vendor || r.payee || r.purpose));
    const ext = extOf((f && f.name) || r.fileName, f && f.mimeType) || (f ? "bin" : "");
    return parts.join("_") + (ext ? "." + ext : "");
  }

  /* ---------------- 後端 ---------------- */
  async function api(action, body) {
    let res;
    try {
      res = await cloudPost(action, body || {});
    } catch (e) {
      throw new Error("連不上伺服器，請確認網路連線後再試一次。");
    }
    if (!res || typeof res !== "object") throw new Error("伺服器沒有回應，請稍後再試一次。");
    if (!res.ok) {
      const err = new Error(res.authError ? "登入已逾期，請重新登入後再試一次。" : String(res.error || "處理失敗，請稍後再試一次。"));
      err.auth = !!res.authError;
      throw err;
    }
    return res;
  }
  async function getOverview(force) {
    if (!force && S.overview && Date.now() - S.overviewAt < 15000) return S.overview;
    const res = await api("financeOverview", {});
    S.overview = {
      today: DATE_RE.test(res.today || "") ? res.today : todayStr(),
      suggestions: arr(res.suggestions),
      activeBatches: arr(res.activeBatches),
      recentBatches: arr(res.recentBatches),
    };
    S.overviewAt = Date.now();
    return S.overview;
  }
  function pendingBatches() { return S.overview ? S.overview.activeBatches.filter((b) => b.status === "待放行") : []; }
  // 徽章跟預設頁只算「可以由我放行」的（自己送出的不能自己放行）
  function releasableCount() { return pendingBatches().filter((b) => !isOwn(b)).length; }
  function refreshBadgeSoon() {
    if (!isReleaser()) return;
    if (S.overview && Date.now() - S.overviewAt < 30000) return;
    getOverview(true).then(renderSubnav).catch(() => { /* 徽章更新失敗不打擾使用者 */ });
  }
  async function loadBatch(id) {
    const res = await api("financeGetBatch", { batchId: id });
    if (!res.batch) throw new Error("伺服器回應裡沒有這一批的資料。");
    const entry = { batch: res.batch, records: orderBatchRecords(res.batch, res.records) };
    S.batches[id] = entry;
    return entry;
  }

  /* ---------------- 外框、導覽、畫面工具 ---------------- */
  function rootEl() { return document.getElementById("opsRoot"); }
  function viewEl() { return document.getElementById("foView"); }

  function ensureFrame() {
    const r = rootEl();
    if (!r) return null;
    if (!r.querySelector(".fo")) {
      r.innerHTML = '<div class="fo"><nav class="fo-subnav" id="foSubnav" aria-label="財務作業"></nav>' +
        '<div class="fo-sr" id="foLive" aria-live="polite" aria-atomic="true"></div><div id="foView"></div></div>';
      r.addEventListener("click", onClick);
      r.addEventListener("change", onChange);
      r.addEventListener("input", onInput);
      r.addEventListener("toggle", onToggle, true);
    }
    return r;
  }

  function renderSubnav() {
    const nav = document.getElementById("foSubnav");
    if (!nav) return;
    const sec = S.route.section;
    const pill = (key, href, label, extra) => '<a class="fo-pill' + (sec === key ? " is-active" : "") + '" href="' + href + '"' +
      (sec === key ? ' aria-current="page"' : "") + ">" + label + (extra || "") + "</a>";
    let h = pill("batches", "#finance/ops/batches", "付款批次");
    if (isReleaser()) {
      const n = releasableCount();
      h += pill("release", "#finance/ops/release", "待放行", n ? '<span class="fo-badge" aria-hidden="true">' + n + '</span><span class="fo-sr">（' + n + " 批等你放行）</span>" : "");
    }
    h += pill("completeness", "#finance/ops/completeness", "單據完備");
    nav.innerHTML = h;
  }

  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
  function focusFk(fk, fallback) {
    const v = viewEl();
    if (!v) return false;
    for (const k of [fk, fallback]) {
      if (!k) continue;
      const el = v.querySelector('[data-fk="' + cssEsc(k) + '"]');
      if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } return true; }
    }
    return false;
  }
  // 重畫畫面：預設把焦點放回原本的元素（同一個 data-fk），鍵盤使用者不會被丟回頁首
  function paint(html, opts) {
    const v = viewEl();
    if (!v) return;
    const o = opts || {};
    let fk = o.focus || null;
    if (!fk && !o.focusHeading) {
      const a = document.activeElement;
      if (a && a !== document.body && v.contains(a)) fk = a.getAttribute("data-fk");
      else if (!a || a === document.body) fk = S.lastFk;
    }
    v.innerHTML = html;
    if (o.focusHeading) {
      const h = v.querySelector("h1");
      if (h) { h.setAttribute("tabindex", "-1"); try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
      return;
    }
    if (fk) focusFk(fk, o.fallback);
  }
  function repaint(opts) { if (typeof S.view === "function") S.view(opts); }
  function paintLoading() {
    paint('<section class="fo-card fo-loading" aria-busy="true"><span class="fo-spinner" aria-hidden="true"></span><p>讀取中…</p></section>');
  }
  function paintError(err, retry) {
    S.view = null;
    S.retry = retry || null;
    const msg = (err && err.message) || "發生錯誤，請再試一次。";
    paint('<section class="fo-card" role="alert"><h1 class="fo-h1">讀取失敗</h1><p class="fo-lead">' + esc(msg) + "</p>" +
      (retry ? '<button type="button" class="fo-btn fo-btn-primary" data-act="retry" data-fk="act:retry">再試一次</button>' : "") +
      "</section>", { focus: "act:retry" });
  }
  function errBox(where) {
    return S.err && S.err.where === where ? '<p class="fo-alert" role="alert">' + esc(S.err.text) + "</p>" : "";
  }
  function roleHint(text) { return '<p class="fo-rolehint">' + esc(text || "只有會計可以操作") + "</p>"; }
  function announce(text) {
    const el = document.getElementById("foLive");
    if (!el) return;
    el.textContent = "";
    setTimeout(() => { el.textContent = text; }, 40);
  }
  function toast(msg) { try { if (typeof showToast === "function") showToast(msg); } catch (e) { /* 沒有 toast 也沒關係 */ } }
  function go(path) {
    const full = "finance/ops/" + path;
    try { if (typeof navigate === "function") { navigate(full); return; } } catch (e) { /* 改用下面的方式 */ }
    location.hash = "#" + full;
  }
  // 換網址但不新增瀏覽紀錄（預設頁、退回的批次轉到第 2 步…），上一頁才不會卡在轉址迴圈
  function replaceRoute(path) {
    try { history.replaceState(history.state, "", "#finance/ops/" + path); } catch (e) { /* 舊瀏覽器：網址不變也能用 */ }
    S.route = parseRest(path.split("/"));
    renderSubnav();
  }
  function chip(text, tone) { return '<span class="fo-chip fo-chip-' + (tone || "grey") + '">' + esc(text) + "</span>"; }
  function statusChip(status) {
    const tone = { "待放行": "amber", "已放行": "green", "已付款": "green", "已完成": "green", "已退回": "red", "已撤回": "grey" }[status] || "grey";
    return chip(status, tone);
  }
  function mention(name) { return '<span class="fo-mention">' + esc(name) + "</span>"; }
  function busyLabel(key, idle, busyText) { return S.busy === key ? busyText || "處理中…" : idle; }

  /* ---------------- 路由 ---------------- */
  function parseRest(rest) {
    const p = arr(rest).map((x) => { try { return decodeURIComponent(String(x)); } catch (e) { return String(x); } });
    const a = p[0] || "";
    if (a === "batches") return { page: "batches", section: "batches" };
    if (a === "pay" && DATE_RE.test(p[1] || "")) return { page: p[2] === "send" ? "send" : "pay", date: p[1], section: "batches" };
    if (a === "batch" && p[1]) return { page: "batch", id: p[1], section: "batches" };
    if (a === "release") return { page: "release", id: p[1] || "", section: "release" };
    if (a === "completeness") return { page: "completeness", section: "completeness" };
    return { page: "default", section: "" };
  }

  const PAGES = {
    default: pageDefault,
    batches: pageBatches,
    pay: pagePay,
    send: pageSend,
    batch: pageBatch,
    release: pageRelease,
    completeness: pageCompleteness,
  };

  function run(route, token, isNav) {
    let p;
    try { p = PAGES[route.page](route, token, isNav); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).catch((e) => {
      if (token !== S.token) return;
      try { console.error("[財務作業]", e); } catch (x) { /* ignore */ }
      paintError(e, () => {
        const t = ++S.token;
        S.route = route;
        renderSubnav();
        paintLoading();
        run(route, t, true);
      });
    });
  }

  function show(rest) {
    try {
      if (!ensureFrame()) return;
      const route = parseRest(rest);
      S.route = route;
      S.err = null;
      S.retry = null;
      S.busy = ""; // 換頁後新畫面的按鈕要能按；舊畫面還沒回來的動作回來時只會更新自己的資料
      S.lastFk = null;
      S.view = null;
      S.relResult = null; // 放行／退回的結果只在剛做完那一次顯示
      const token = ++S.token;
      renderSubnav();
      if (route.page !== "default" && route.page !== "batches" && route.page !== "release") refreshBadgeSoon();
      run(route, token, true);
    } catch (e) {
      try {
        const v = viewEl() || rootEl();
        if (v) v.innerHTML = '<section class="fo-card" role="alert"><p>財務作業畫面出了問題：' + esc(e && e.message) + "。請重新整理頁面再試一次。</p></section>";
      } catch (x) { /* 真的沒辦法了 */ }
    }
  }

  async function pageDefault(route, token) {
    paintLoading();
    const ov = await getOverview(true);
    if (token !== S.token) return;
    let target = "completeness";
    if (isReleaser() && ov.activeBatches.some((b) => b.status === "待放行" && !isOwn(b))) target = "release";
    else if (isAccountant()) target = "batches";
    replaceRoute(target);
    return PAGES[target](S.route, token, true);
  }

  /* ============================================================
     付款批次 ① 選批次
     ============================================================ */
  async function pageBatches(route, token, isNav) {
    if (isNav) paintLoading();
    await getOverview(true);
    if (token !== S.token) return;
    renderSubnav();
    S.view = paintBatches;
    paintBatches({ focusHeading: isNav });
  }

  function stepsBar(current, opts) {
    const o = opts || {};
    const labels = ["選批次", "核對清單", o.waiting ? "等" + RELEASER + "放行" : "匯入兆豐、送出放行", "確認已付款", "記到藍途"];
    return '<ol class="fo-steps" aria-label="付款批次步驟">' + labels.map((label, i) => {
      const n = i + 1;
      const done = o.allDone || n < current;
      const cur = !o.allDone && n === current;
      return '<li class="fo-step' + (cur ? " is-current" : "") + (done ? " is-done" : "") + '"' + (cur ? ' aria-current="step"' : "") + ">" +
        '<span class="fo-step-num" aria-hidden="true">' + (done ? ICON_TICK : n) + "</span>" +
        '<span class="fo-step-label"><span class="fo-sr">第 ' + n + " 步：</span>" + esc(label) + (done ? '<span class="fo-sr">（已完成）</span>' : "") + "</span></li>";
    }).join("") + "</ol>";
  }

  function rhythmBox() {
    const items = [["3 號", "產生 5 號批次"], ["5 號", "確認已付款、記到藍途"], ["10–13 號", "主管審核"], ["18 號", "產生 20 號批次"], ["20 號", "確認已付款、記到藍途"]];
    return '<div class="fo-rhythm"><p class="fo-rhythm-title">每個月的固定節奏</p><ul class="fo-rhythm-list">' +
      items.map((x) => "<li><strong>" + x[0] + "</strong>" + x[1] + "</li>").join("") + "</ul></div>";
  }

  function daysChip(today, payDate) {
    const d = dayNum(payDate) - dayNum(today);
    if (!isFinite(d)) return "";
    if (d === 0) return chip("今天", "amber");
    if (d > 0) return chip(d + " 天後", "amber");
    return chip("已過 " + (-d) + " 天", "red");
  }

  function batchSumText(b) {
    let t = num(b.count) + " 筆・" + money(b.total);
    if (num(b.salaryTotal)) t += "（另加薪資 " + money(b.salaryTotal) + "）";
    if (num(b.heldCount)) t += "・不放行 " + num(b.heldCount) + " 筆";
    return t;
  }
  function batchWhoText(b) {
    switch (b.status) {
      case "待放行": return (shortName(b.sentByName) || ACCOUNTANT) + " " + mdhm(b.sentAt) + " 送出，等放行";
      case "已放行": return (shortName(b.releasedByName) || RELEASER) + " " + mdhm(b.releasedAt) + " 放行，等確認已付款";
      case "已付款": return md(b.paidDate || b.payDate) + " 匯出，還沒記到藍途";
      case "已完成": return (b.doneAt ? mdhm(b.doneAt) + " 完成" : "已完成") + (b.paidDate ? "（" + md(b.paidDate) + " 匯出）" : "");
      case "已退回": return (shortName(b.releasedByName) || RELEASER) + " " + mdhm(b.releasedAt) + " 退回：" + (b.returnReason || "");
      case "已撤回": return (shortName(b.sentByName) || ACCOUNTANT) + " 撤回了放行請求";
      default: return "";
    }
  }

  function pickCard(s, today, active) {
    const label = batchLabel(s.payDate, s.type);
    const g = s.groups || {};
    const running = active.filter((b) => b.payDate === s.payDate);
    let h = '<article class="fo-pick" aria-labelledby="foPick-' + esc(s.payDate) + '"><div class="fo-pick-head"><h2 class="fo-h2" id="foPick-' + esc(s.payDate) + '">' + esc(label) + "</h2>" + daysChip(today, s.payDate) + "</div>";
    h += '<p class="fo-muted">' + esc(TYPE_DESC[s.type] || TYPE_DESC["臨時"]) + "</p>";
    if (num(s.count)) {
      h += '<p class="fo-pick-sum">' + num(s.count) + " 筆待付・合計 " + money(s.total) + "</p>";
      const parts = GROUPS.filter((k) => g[k] && num(g[k].count));
      if (parts.length) {
        h += '<ul class="fo-parts" aria-label="組成">' + parts.map((k) => "<li><span>" + GROUP_NAME[k] + "</span><span>" + num(g[k].count) + " 筆・" + money(g[k].total) + "</span></li>").join("") + "</ul>";
      }
    } else {
      h += '<p class="fo-pick-sum">目前沒有待付的單據</p>';
    }
    if (running.length) h += '<p class="fo-note fo-note-info">這一天已經有一批「' + esc(running[0].status) + "」，可以在下面「進行中的批次」繼續。</p>";
    h += num(s.count)
      ? '<a class="fo-btn fo-btn-primary fo-btn-block fo-pick-btn" href="#finance/ops/pay/' + esc(s.payDate) + '" data-fk="start:' + esc(s.payDate) + '">開始處理<span class="fo-sr">（' + esc(label) + "）</span></a>"
      : '<button type="button" class="fo-btn fo-btn-primary fo-btn-block fo-pick-btn" disabled>開始處理</button>';
    return h + "</article>";
  }

  function otherDateCard() {
    return '<div class="fo-pick fo-pick-other"><h2 class="fo-h2">其他日期</h2>' +
      '<p class="fo-muted">臨時要付的款項：選一個付款日，系統會列出預計撥款日在這一天以前的單據。</p>' +
      '<label class="fo-label" for="foOtherDate">付款日</label>' +
      '<input type="date" class="fo-input" id="foOtherDate" data-act="otherDate" data-fk="otherDate" value="' + esc(S.otherDate) + '">' +
      errBox("otherDate") +
      '<button type="button" class="fo-btn fo-btn-secondary fo-btn-block fo-pick-btn" data-act="startOther" data-fk="act:startOther">開始處理<span class="fo-sr">（其他日期）</span></button></div>';
  }

  function batchRow(b, linkText) {
    const label = batchLabel(b.payDate, b.type);
    let h = '<li class="fo-brow"><div class="fo-brow-main"><div class="fo-brow-title"><strong>' + esc(label) + "</strong>" + statusChip(b.status) + "</div>" +
      '<div class="fo-muted">' + esc(batchSumText(b)) + '</div><div class="fo-muted">' + esc(batchWhoText(b)) + "</div></div>";
    if (linkText) h += '<a class="fo-btn fo-btn-secondary" href="#finance/ops/batch/' + encodeURIComponent(b.id) + '" data-fk="open:' + esc(b.id) + '">' + esc(linkText) + '<span class="fo-sr">（' + esc(label) + "）</span></a>";
    return h + "</li>";
  }

  function paintBatches(opts) {
    const ov = S.overview || { today: todayStr(), suggestions: [], activeBatches: [], recentBatches: [] };
    const active = ov.activeBatches;
    let h = stepsBar(1);
    h += '<section class="fo-card"><h1 class="fo-h1">付款批次</h1>';
    h += '<p class="fo-lead">選一個批次開始。系統會列出已核准、還沒付款、預計撥款日在這一天以前的單據。</p>';
    if (!isAccountant()) h += roleHint("只有會計可以操作：你可以看清單，送出、確認付款的按鈕會停用。");
    h += rhythmBox();
    h += '<div class="fo-picks">' + ov.suggestions.map((s) => pickCard(s, ov.today, active)).join("") + otherDateCard() + "</div></section>";
    if (active.length) {
      h += '<section class="fo-card" aria-labelledby="foActiveH"><h2 class="fo-h2" id="foActiveH">進行中的批次</h2>' +
        '<p class="fo-muted">已經送出放行請求、還沒完成的批次，從上次停下來的地方繼續。</p><ul class="fo-blist">' +
        active.map((b) => batchRow(b, NEXT_LABEL[b.status] || "打開")).join("") + "</ul></section>";
    }
    if (ov.recentBatches.length) {
      h += '<details class="fo-card fo-details" id="foRecent"' + (S.recentOpen ? " open" : "") + '><summary data-fk="recent">最近的批次（' + ov.recentBatches.length + "）</summary>" +
        '<ul class="fo-blist">' + ov.recentBatches.map((b) => batchRow(b, b.status === "已完成" ? "看這一批" : "")).join("") + "</ul></details>";
    }
    paint(h, opts);
  }

  /* ============================================================
     付款批次 ② 核對清單
     ============================================================ */
  function defaultPick(r) { return !(r.releaseNote || r.legacy); }

  async function loadDraft(date) {
    const res = await api("financeCandidates", { payDate: date });
    const prev = S.drafts[date] || null;
    const records = orderRecords(res.records);
    const lr = res.lastReturned && typeof res.lastReturned === "object" ? res.lastReturned : null;
    const type = res.type || (prev && prev.type) || "臨時";
    const selected = {};
    records.forEach((r) => {
      if (prev && has(prev.selected, r.id)) selected[r.id] = !!prev.selected[r.id];
      else if (prev && prev.othersOff) selected[r.id] = false;
      else selected[r.id] = defaultPick(r);
    });
    let salary = prev ? prev.salary : "";
    if (!salary && type === "5號" && lr && num(lr.salaryTotal)) salary = String(num(lr.salaryTotal));
    const d = {
      payDate: DATE_RE.test(res.payDate || "") ? res.payDate : date,
      type, records, lastReturned: lr, selected, salary,
      bankChecked: prev ? !!prev.bankChecked : false,
      bankFile: prev ? prev.bankFile || "" : "",
    };
    S.drafts[date] = d;
    return d;
  }

  async function pagePay(route, token, isNav) {
    if (isNav) paintLoading();
    await loadDraft(route.date);
    if (token !== S.token) return;
    S.view = (o) => paintPay(route.date, o);
    paintPay(route.date, { focusHeading: isNav });
  }

  function selectedRecords(d) { return d.records.filter((r) => d.selected[r.id]); }
  function payTotals(d) {
    const sel = selectedRecords(d);
    const salary = d.type === "5號" ? toInt(d.salary) : 0;
    return { count: sel.length, total: sum(sel), excluded: d.records.length - sel.length, salary };
  }

  function rowNote(r) {
    return r.releaseNote ? '<span class="fo-rnote" id="foRn-' + esc(r.id) + '">上次沒有放行：' + esc(r.releaseNote) + "</span>" : "";
  }
  function fileLink(r, who) {
    const url = safeUrl(r.fileUrl);
    if (r.hasFile && url) return '<a class="fo-link" href="' + esc(url) + '" target="_blank" rel="noopener">看憑證<span class="fo-sr">（' + esc(who) + "，另開新分頁）</span></a>";
    if (r.hasFile) return '<span class="fo-muted fo-small">有單據（沒有連結）</span>';
    return '<span class="fo-muted fo-small">沒有單據</span>';
  }
  function dueChip(r, payDate) {
    if (!r.billDueDate) return "";
    const late = payDate && dayNum(r.billDueDate) < dayNum(payDate);
    return chip("繳費期限 " + md(r.billDueDate) + (late ? "（在付款日之前）" : ""), late ? "red" : "amber");
  }
  function checkboxHtml(d, r, aria) {
    const on = !!d.selected[r.id];
    return '<input type="checkbox" class="fo-checkbox" data-act="pick" data-id="' + esc(r.id) + '" data-fk="pick:' + esc(r.id) + '"' + (on ? " checked" : "") +
      ' aria-label="' + esc("這次要付：" + aria + " " + money(r.amount)) + '"' + (r.releaseNote ? ' aria-describedby="foRn-' + esc(r.id) + '"' : "") + ">";
  }

  function personSumText(d, items) {
    const incl = items.filter((r) => d.selected[r.id]);
    const off = items.length - incl.length;
    return incl.length + " 筆・" + money(sum(incl)) + (off ? "（這次不付 " + off + " 筆）" : "");
  }

  function reimbCard(d, list) {
    let h = '<section class="fo-card fo-card-tight" aria-labelledby="foReimbH"><h2 class="fo-h2" id="foReimbH">代墊款</h2>' +
      '<p class="fo-muted fo-mb">跟薪資一起匯。同仁的帳號兆豐已經建好檔，這裡不用再核對帳號。</p>';
    people(list).forEach((p, i) => {
      h += '<div class="fo-person" data-pidx="' + i + '"><div class="fo-person-head"><span>' + esc(p.name) + '</span><span class="fo-person-sum">' + esc(personSumText(d, p.items)) + "</span></div>";
      p.items.forEach((r) => {
        const on = !!d.selected[r.id];
        h += '<label class="fo-pick-row' + (on ? "" : " is-off") + '" data-row="' + esc(r.id) + '">' + checkboxHtml(d, r, p.name + " " + (r.purpose || "")) +
          '<span class="fo-grow"><span class="fo-row-title">' + esc(r.purpose || "（沒有寫用途）") + '</span><span class="fo-muted">（' + esc(r.center || "—") + "）</span>" +
          (r.urgent ? " " + chip("緊急", "red") : "") + rowNote(r) +
          '<span class="fo-row-meta">' + esc([r.vendor, r.invoiceDate].filter(Boolean).join("・")) + (r.vendor || r.invoiceDate ? "　" : "") + fileLink(r, p.name + " " + (r.purpose || "")) + "</span></span>" +
          '<span class="fo-amt">' + money(r.amount) + "</span></label>";
      });
      h += "</div>";
    });
    return h + "</section>";
  }

  function transferCard(d, list) {
    let h = '<section class="fo-card fo-card-tight" aria-labelledby="foTrH"><h2 class="fo-h2" id="foTrH">匯款給廠商／外部個人</h2>' +
      '<p class="fo-muted fo-mb">戶名、銀行分行、帳號都已經分好欄，可以直接對照兆豐後台建檔。</p>' +
      '<div class="fo-scroll" role="region" aria-labelledby="foTrH" tabindex="0"><div class="fo-ttable">' +
      '<div class="fo-thead" aria-hidden="true"><span>付</span><span>戶名／用途</span><span>銀行・分行代碼</span><span>帳號</span><span class="fo-right">金額</span></div>';
    list.forEach((r) => {
      const on = !!d.selected[r.id];
      const payee = r.accountName || r.payee || r.vendor || "（沒有戶名）";
      const legacy = r.legacy || !r.account;
      let tags = "";
      if (r.firstTime) tags += chip("第一次匯給這個帳號，請核對", "red");
      if (r.fixedExpense) tags += chip("每月固定支出", "navy");
      if (r.urgent) tags += chip("緊急", "red");
      h += '<label class="fo-trow' + (on ? "" : " is-off") + '" data-row="' + esc(r.id) + '">' + checkboxHtml(d, r, payee + " " + (r.purpose || "")) +
        '<span class="fo-tc fo-tc-payee"><strong class="fo-row-title">' + esc(payee) + "</strong>" +
        '<span class="fo-row-sub">' + esc(r.purpose || "") + '<span class="fo-muted">（提交人 ' + esc(r.uploader || "—") + "）</span></span>" +
        (tags ? '<span class="fo-tags">' + tags + "</span>" : "") + rowNote(r) +
        '<span class="fo-row-meta">' + fileLink(r, payee + " " + (r.purpose || "")) + "</span></span>" +
        '<span class="fo-tc fo-tc-bank">' + (legacy
          ? '<span class="fo-legacy">舊格式，只寫了「' + esc(r.paymentDetail || "（空白）") + "」。帳號不完整，系統先幫你取消勾選。</span>"
          : esc(r.bankName || "") + '　<span class="fo-mono">' + esc(fmtBranch(r.branch)) + "</span>") + "</span>" +
        '<span class="fo-tc fo-tc-acct fo-mono">' + (legacy ? "—" : groupDigits(r.account)) + "</span>" +
        '<span class="fo-tc fo-tc-amt fo-right fo-amt">' + money(r.amount) + "</span></label>";
    });
    return h + "</div></div></section>";
  }

  function billCard(d, list) {
    let h = '<section class="fo-card fo-card-tight" aria-labelledby="foBillH"><h2 class="fo-h2" id="foBillH">繳費單（網銀代繳）</h2>' +
      '<p class="fo-muted fo-mb">稅金、健保費這類繳費單，用網銀代繳，不經過整批匯款。</p>';
    list.forEach((r) => {
      const on = !!d.selected[r.id];
      const who = r.payee || r.vendor || "";
      h += '<label class="fo-pick-row fo-bill-row' + (on ? "" : " is-off") + '" data-row="' + esc(r.id) + '">' + checkboxHtml(d, r, who + " " + (r.purpose || "")) +
        '<span class="fo-grow"><span class="fo-row-title"><strong>' + esc(who) + "</strong>｜" + esc(r.purpose || "") + "</span>" +
        '<span class="fo-muted">（提交人 ' + esc(r.uploader || "—") + "）</span>" + rowNote(r) +
        '<span class="fo-row-meta">' + fileLink(r, who + " " + (r.purpose || "")) + "</span></span>" +
        dueChip(r, d.payDate) + '<span class="fo-amt">' + money(r.amount) + "</span></label>";
    });
    return h + "</section>";
  }

  function paySumParts(d) {
    const t = payTotals(d);
    return {
      t,
      big: t.count + " 筆・" + money(t.total),
      salary: t.salary ? "另加薪資 " + money(t.salary) + "，總計 " + money(t.total + t.salary) : "",
      excl: t.excluded ? t.excluded + " 筆這次不付，會留到下一批" : "",
    };
  }

  function paintPay(date, opts) {
    const d = S.drafts[date];
    if (!d) return;
    const canAct = isAccountant();
    const g = groupOf(d.records);
    const lr = d.lastReturned;
    let h = stepsBar(2);
    const lrIds = lr ? arr(lr.recordIds).map(String) : [];
    if (lr && (!lrIds.length || d.records.some((r) => lrIds.indexOf(r.id) >= 0))) {
      const heldN = Object.keys(heldMap(lr)).length;
      h += '<section class="fo-banner fo-banner-red" role="status"><p class="fo-banner-title">' + esc(shortName(lr.releasedByName) || RELEASER) + "把上一批退回了</p>" +
        "<p>原因：" + esc(endPunct(lr.returnReason || "（沒有寫原因）")) + "改好兆豐的檔案之後，再送出一次放行請求。</p>" +
        (heldN ? "<p>標了不放行的 " + heldN + " 筆先取消勾選了，旁邊有原因。</p>" : "") + "</section>";
    }
    h += '<section class="fo-card"><h1 class="fo-h1">' + esc(batchLabel(date, d.type)) + "：核對清單</h1>" +
      '<p class="fo-lead fo-mb0">勾選這次要付的款項。沒勾的會留在清單上，下一批再出現。</p>' + (canAct ? "" : roleHint()) + "</section>";
    if (d.type === "5號") {
      h += '<section class="fo-card fo-card-tight"><label class="fo-label-strong" for="foSalary">本月薪資總額（從 Swingvy 抄過來）</label>' +
        '<input class="fo-input" id="foSalary" data-act="salary" data-fk="salary" inputmode="numeric" autocomplete="off" placeholder="例如 150000" value="' + esc(d.salary) + '" aria-describedby="foSalaryHint">' +
        '<p class="fo-hint" id="foSalaryHint">只填總額。個人薪資不會出現在系統或任何通知裡。</p></section>';
    }
    if (!d.records.length) {
      h += '<section class="fo-card fo-empty"><p>' + esc(md(date)) + " 以前沒有待付的單據。已核准、還沒付款、要匯款或代繳的單據，才會出現在這裡。</p></section>";
    }
    if (g.reimb.length) h += reimbCard(d, g.reimb);
    if (g.transfer.length) h += transferCard(d, g.transfer);
    if (g.bill.length) h += billCard(d, g.bill);
    const p = paySumParts(d);
    h += '<section class="fo-sumbar" aria-label="本批合計"><div class="fo-sumbar-main"><div class="fo-sumbar-label">本批要付</div>' +
      '<div class="fo-sumbar-big" id="foSumBig">' + esc(p.big) + "</div>" +
      '<div class="fo-sumbar-sub" id="foSumSalary"' + (p.salary ? "" : " hidden") + ">" + esc(p.salary) + "</div>" +
      '<div class="fo-sumbar-sub" id="foSumExcl"' + (p.excl ? "" : " hidden") + ">" + esc(p.excl) + "</div></div>" +
      '<div class="fo-sumbar-actions"><a class="fo-btn fo-btn-light" href="#finance/ops/batches" data-fk="back">上一步</a>' +
      '<button type="button" class="fo-btn fo-btn-primary" id="foNext" data-act="toSend" data-fk="act:toSend"' + (canAct && p.t.count ? "" : " disabled") + ">下一步：匯入兆豐、送出放行</button></div>" +
      (canAct ? '<p class="fo-sumbar-hint" id="foNextHint"' + (p.t.count ? " hidden" : "") + ">至少勾一筆，才能進下一步</p>" : '<p class="fo-sumbar-hint">只有會計可以操作</p>') +
      "</section>";
    paint(h, opts);
  }

  // 勾選、改薪資時只更新數字，不重畫整頁（游標、捲動位置都不會跑掉）
  function patchPay(date) {
    const d = S.drafts[date];
    const v = viewEl();
    if (!d || !v) return;
    const p = paySumParts(d);
    const set = (id, text) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.hidden = !text; } };
    set("foSumBig", p.big);
    set("foSumSalary", p.salary);
    set("foSumExcl", p.excl);
    const next = document.getElementById("foNext");
    if (next) next.disabled = !(isAccountant() && p.t.count);
    const hint = document.getElementById("foNextHint");
    if (hint) hint.hidden = !!p.t.count;
    const ppl = people(groupOf(d.records).reimb);
    v.querySelectorAll(".fo-person[data-pidx]").forEach((el) => {
      const x = ppl[+el.getAttribute("data-pidx")];
      const s = el.querySelector(".fo-person-sum");
      if (x && s) s.textContent = personSumText(d, x.items);
    });
  }

  /* ============================================================
     付款批次 ③ 匯入兆豐、送出放行
     ============================================================ */
  async function pageSend(route, token, isNav) {
    const d = S.drafts[route.date];
    if (!d || !selectedRecords(d).length) {
      // 重新整理頁面後草稿就沒了：回第 2 步重新勾
      replaceRoute("pay/" + route.date);
      return pagePay(S.route, token, isNav);
    }
    S.view = (o) => paintSend(route.date, o);
    paintSend(route.date, { focusHeading: isNav });
  }

  function bankCard(o) {
    const g = groupOf(o.records);
    const ppl = people(g.reimb);
    const lines = [];
    if (g.transfer.length) lines.push("匯款給廠商／外部個人：" + g.transfer.length + " 筆，" + money(sum(g.transfer)) + "（戶名、分行代碼、帳號、金額都已帶入）");
    if (g.reimb.length) lines.push("代墊款：" + ppl.length + " 人，" + money(sum(g.reimb)) + "（每人合計一筆，跟薪資一起匯）");
    const legacyN = g.transfer.filter((r) => r.legacy || !r.account).length;
    const not = [];
    if (o.type === "5號" || o.salary) not.push("薪資用 Swingvy 的薪轉檔");
    if (g.bill.length) not.push("繳費單 " + g.bill.length + " 筆用網銀的繳費功能另外繳");
    let h = '<div class="fo-box"><p class="fo-kicker">先匯入兆豐</p><h2 class="fo-h3 fo-mt0">兆豐匯入檔（Excel）</h2>';
    h += lines.length ? '<ul class="fo-ul">' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>" : '<p class="fo-muted fo-mb">這一批沒有要整批匯款的款項。</p>';
    if (legacyN) h += '<p class="fo-note fo-note-amber fo-mb">其中 ' + legacyN + " 筆是舊格式，檔案裡沒有帳號，要在兆豐自己補上。</p>";
    if (not.length) h += '<p class="fo-note fo-note-grey fo-mb">不在檔案裡：' + esc(not.join("；")) + "。</p>";
    h += '<button type="button" class="fo-btn fo-btn-primary fo-btn-wide" data-act="dlBank" data-fk="act:dlBank"' + (S.busy === "dlBank" ? " disabled" : "") + ">" + busyLabel("dlBank", "下載兆豐匯入檔", "產生檔案中…") + "</button>";
    if (o.fileDone) h += '<p class="fo-ok">已下載 ' + esc(o.fileDone) + "</p>";
    h += errBox("dlBank");
    h += '<p class="fo-note fo-note-amber">目前是暫定格式，拿到兆豐的匯入範本後會改成可以直接匯入的格式</p>';
    h += '<label class="fo-check-line"><input type="checkbox" class="fo-checkbox" data-act="bankChecked" data-fk="bankChecked"' + (o.checked ? " checked" : "") +
      (o.locked || !o.canAct ? " disabled" : "") + "><span>已經在兆豐匯入、建好檔</span></label>";
    return h + "</div>";
  }

  function slackCard(channel, lines, label) {
    let h = '<article class="fo-slack" aria-label="' + esc((label || "Slack 訊息預覽") + "（" + channel + "）") + '"><div class="fo-slack-ch">' + esc(channel) + "</div>" +
      '<div class="fo-slack-body"><span class="fo-slack-avatar" aria-hidden="true">R</span><div class="fo-slack-msg">' +
      '<div class="fo-slack-who"><strong>Receipt Helper</strong> <span class="fo-slack-app">APP</span></div>';
    lines.forEach((l) => {
      h += '<div class="fo-slack-line' + (l.indent ? " is-indent" : "") + (l.gap ? " is-gap" : "") + '">' +
        (l.icon === "check" ? ICON_CHECK : "") + (l.icon === "coin" ? '<span class="fo-coin" aria-hidden="true">NT$</span>' : "") + l.html + "</div>";
    });
    return h + "</div></div></article>";
  }
  function fakeLink(text) { return '<span class="fo-slack-link">' + esc(text) + "</span>"; }

  // 訊息 A：放行請求（#team-組織發展中心）
  function msgALines(payDate, type, recs, salary, salaryMissing) {
    const g = groupOf(recs);
    const ppl = people(g.reimb);
    const L = [{ html: mention("@" + RELEASER) + " " + esc(md(payDate)) + " 付款批次已在兆豐建檔，請到" + APP_NAME + "核對後放行" }];
    if (type === "5號" || salary) {
      L.push({ html: "• 薪資：" + (salaryMissing ? "（還沒填，請回上一步填 Swingvy 薪資總額）" : esc(money(salary))) + "（Swingvy 總額，不列個人金額）" });
    }
    if (g.reimb.length) {
      L.push({ html: "• 代墊款：" + ppl.length + " 人、" + g.reimb.length + " 筆，" + esc(money(sum(g.reimb))) });
      ppl.forEach((p) => L.push({ indent: true, html: "－ " + esc(p.name) + " " + p.items.length + " 筆 " + esc(money(sum(p.items))) }));
    }
    if (g.transfer.length) L.push({ html: "• 匯款給廠商／外部個人：" + g.transfer.length + " 筆，" + esc(money(sum(g.transfer))) });
    if (g.bill.length) L.push({ html: "• 網銀代繳（繳費單）：" + g.bill.length + " 筆，" + esc(money(sum(g.bill))) });
    L.push({ gap: true, html: "→ " + fakeLink("核對並放行：" + APP_NAME + "「財務作業 › 待放行」") });
    return L;
  }

  function paintSend(date, opts) {
    const d = S.drafts[date];
    if (!d) return;
    const canAct = isAccountant();
    const recs = selectedRecords(d);
    const salaryMissing = d.type === "5號" && d.salary === "";
    const salary = d.type === "5號" ? toInt(d.salary) : 0;
    const canSend = canAct && d.bankChecked && !salaryMissing && recs.length && !S.busy;
    let h = stepsBar(3);
    h += '<section class="fo-card"><h1 class="fo-h1">匯入兆豐、送出放行</h1>' +
      '<p class="fo-lead">先下載兆豐匯入檔，到兆豐企業網銀的整批付款匯入建檔。建好之後打勾，再送出放行請求：系統會在 ' + FIN_CHANNEL + " tag " + RELEASER +
      "，他在" + APP_NAME + "「待放行」核對、在兆豐放行，按了「確認放行」之後，第 4 步才會打開。</p>";
    if (!canAct) h += roleHint();
    h += bankCard({ type: d.type, records: recs, salary, fileDone: d.bankFile, checked: d.bankChecked, locked: false, canAct });
    h += '<h2 class="fo-h3">送出後會發這則訊息</h2>' + slackCard(FIN_CHANNEL, msgALines(date, d.type, recs, salary, salaryMissing), "送出後會發的訊息");
    if (salaryMissing) h += '<p class="fo-note fo-note-amber">還沒填本月薪資總額：請回上一步，填 Swingvy 的薪資總額。</p>';
    h += errBox("send");
    h += '<div class="fo-actions"><a class="fo-btn fo-btn-secondary" href="#finance/ops/pay/' + esc(date) + '" data-fk="back">上一步</a>' +
      '<button type="button" class="fo-btn fo-btn-primary" id="foSend" data-act="send" data-fk="act:send"' + (canSend ? "" : " disabled") + ">" + busyLabel("send", "送出放行請求", "送出中…") + "</button></div>";
    if (canAct && !d.bankChecked) h += '<p class="fo-hint fo-right-text">在兆豐建好檔、勾了「已經在兆豐匯入、建好檔」，才能送出。</p>';
    h += "</section>";
    paint(h, opts);
  }

  async function actSend() {
    const date = S.route.date;
    const d = S.drafts[date];
    if (!d || !isAccountant() || S.busy) return;
    const recs = selectedRecords(d);
    if (!recs.length || !d.bankChecked || (d.type === "5號" && d.salary === "")) return;
    const token = S.token;
    S.busy = "send";
    S.err = null;
    repaint();
    try {
      const res = await api("financeSendRelease", { payDate: date, recordIds: recs.map((r) => r.id), salaryTotal: d.type === "5號" ? toInt(d.salary) : 0 });
      S.busy = "";
      if (!res.batch || !res.batch.id) throw new Error("伺服器回應裡沒有批次資料，請到「付款批次」看看有沒有送出。");
      S.batches[res.batch.id] = { batch: res.batch, records: recs };
      S.ui[res.batch.id] = { bankFile: d.bankFile };
      delete S.drafts[date];
      S.overview = null;
      toast("已送出放行請求");
      announce("已送出放行請求，等" + RELEASER + "放行");
      if (token === S.token) go("batch/" + encodeURIComponent(res.batch.id));
    } catch (e) {
      S.busy = "";
      if (token !== S.token) return;
      S.err = { where: "send", text: e.message };
      repaint();
    }
  }

  /* ============================================================
     已送出的批次：③ 等放行／④ 確認已付款／⑤ 記到藍途
     ============================================================ */
  function uiOf(id) { if (!S.ui[id]) S.ui[id] = {}; return S.ui[id]; }

  async function pageBatch(route, token, isNav) {
    if (isNav) paintLoading();
    await loadBatch(route.id);
    if (token !== S.token) return;
    return routeBatch(route.id, token, isNav);
  }

  function routeBatch(id, token, isNav) {
    const b = S.batches[id].batch;
    if (b.status === "已退回" || b.status === "已撤回") {
      // 退回、撤回的批次回到第 2 步：放行人標了不放行的會先取消勾選（後端也會在那幾筆帶上原因）
      const d = S.drafts[b.payDate];
      if (d) Object.keys(heldMap(b)).forEach((k) => { d.selected[k] = false; });
      if (b.status === "已退回") toast((shortName(b.releasedByName) || RELEASER) + "把這一批退回了，回到第 2 步");
      replaceRoute("pay/" + b.payDate);
      return pagePay(S.route, token, isNav);
    }
    S.view = (o) => paintBatch(id, o);
    paintBatch(id, { focusHeading: isNav });
  }

  function paintBatch(id, opts) {
    const entry = S.batches[id];
    if (!entry) return;
    const st = entry.batch.status;
    if (st === "待放行") return paintWaiting(id, opts);
    if (st === "已放行") return paintConfirm(id, opts);
    if (st === "已付款" || st === "已完成") return paintBlueway(id, opts);
    paint('<section class="fo-card"><h1 class="fo-h1">' + esc(batchLabel(entry.batch.payDate, entry.batch.type)) + '</h1><p class="fo-lead">這一批的狀態是「' + esc(st || "不明") +
      '」。</p><a class="fo-btn fo-btn-secondary" href="#finance/ops/batches">回到批次列表</a></section>', opts);
  }

  function paintWaiting(id, opts) {
    const { batch: b, records } = S.batches[id];
    const ui = uiOf(id);
    const canAct = isAccountant();
    const salary = num(b.salaryTotal);
    let h = stepsBar(3, { waiting: true });
    h += '<section class="fo-card"><h1 class="fo-h1">' + esc(batchLabel(b.payDate, b.type)) + "：等" + RELEASER + "放行</h1>" +
      '<p class="fo-lead">' + esc((shortName(b.sentByName) || ACCOUNTANT) + " " + mdhm(b.sentAt) + " 送出放行請求，" + batchSumText(b) + "。") + "</p>";
    h += '<div class="fo-callout" role="status"><p>已送出到 ' + FIN_CHANNEL + "。等" + RELEASER + "放行，他按了「確認放行」之後，第 4 步才會打開。</p>" +
      (ui.checkedAt ? '<p class="fo-small">' + esc(ui.checkedAt) + " 查過：還在等放行。</p>" : "") + "</div>";
    if (!canAct) h += roleHint();
    h += bankCard({ type: b.type, records, salary, fileDone: ui.bankFile, checked: true, locked: true, canAct });
    h += '<h2 class="fo-h3">已發出的訊息</h2>' + slackCard(FIN_CHANNEL, msgALines(b.payDate, b.type, records, salary, false), "已發出的訊息");
    h += errBox("waiting");
    h += '<div class="fo-actions">' +
      '<button type="button" class="fo-btn fo-btn-secondary" data-act="refreshBatch" data-fk="act:refreshBatch"' + (S.busy ? " disabled" : "") + ">" + busyLabel("refreshBatch", "重新整理狀態", "查詢中…") + "</button>" +
      '<button type="button" class="fo-btn fo-btn-secondary" data-act="withdrawAsk" data-fk="act:withdrawAsk" aria-expanded="' + !!ui.withdrawAsk + '"' + (canAct && !S.busy ? "" : " disabled") + ">撤回放行請求</button></div>";
    if (ui.withdrawAsk && canAct) {
      h += '<div class="fo-confirm" role="group" aria-labelledby="foWdQ"><p id="foWdQ"><strong>確定要撤回嗎？</strong>撤回之後' + RELEASER +
        "就不能放行這一批，這批會回到第 2 步「核對清單」。兆豐網銀裡建好的檔，也要記得刪掉。</p>" + errBox("withdraw") +
        '<div class="fo-actions"><button type="button" class="fo-btn fo-btn-secondary" data-act="withdrawCancel" data-fk="act:withdrawCancel">先不要</button>' +
        '<button type="button" class="fo-btn fo-btn-danger" data-act="withdraw" data-fk="act:withdraw"' + (S.busy ? " disabled" : "") + ">" + busyLabel("withdraw", "確定撤回", "撤回中…") + "</button></div></div>";
    }
    h += "</section>";
    paint(h, opts);
  }

  async function actRefreshBatch() {
    const id = S.route.id;
    if (!id || S.busy) return;
    const token = S.token;
    S.busy = "refreshBatch";
    S.err = null;
    repaint();
    try {
      const entry = await loadBatch(id);
      S.busy = "";
      if (token !== S.token) return;
      if (entry.batch.status === "待放行") {
        uiOf(id).checkedAt = nowHM();
        announce("還在等" + RELEASER + "放行");
        repaint();
      } else {
        announce("狀態更新：" + entry.batch.status);
        S.overview = null;
        window.scrollTo(0, 0);
        routeBatch(id, token, true);
      }
    } catch (e) {
      S.busy = "";
      if (token !== S.token) return;
      S.err = { where: "waiting", text: e.message };
      repaint();
    }
  }

  async function actWithdraw() {
    const id = S.route.id;
    const entry = S.batches[id];
    if (!entry || !isAccountant() || S.busy) return;
    const token = S.token;
    S.busy = "withdraw";
    S.err = null;
    repaint();
    try {
      const res = await api("financeWithdraw", { batchId: id });
      S.busy = "";
      const b = res.batch || entry.batch;
      // 回到第 2 步時保留原本的勾選和薪資總額
      const selected = {};
      (arr(b.recordIds).length ? arr(b.recordIds) : entry.records.map((r) => r.id)).forEach((rid) => { selected[String(rid)] = true; });
      S.drafts[b.payDate] = { payDate: b.payDate, type: b.type, records: [], selected, othersOff: true, salary: b.type === "5號" ? String(num(b.salaryTotal)) : "", bankChecked: false, bankFile: "" };
      delete S.ui[id];
      S.overview = null;
      toast("已撤回放行請求，兆豐裡建好的檔記得刪掉");
      if (token === S.token) go("pay/" + b.payDate);
    } catch (e) {
      S.busy = "";
      if (token !== S.token) return;
      S.err = { where: "withdraw", text: e.message };
      repaint();
    }
  }

  // ④ 確認已付款
  function msgs4Html(b, paid, paidDate) {
    const g = groupOf(paid);
    const ext = g.transfer.concat(g.bill);
    const day = esc(md(paidDate || b.payDate));
    const link = { gap: true, html: "明細請到" + fakeLink(APP_NAME + "「上傳紀錄」") + "查看" };
    const cards = [];
    if (g.reimb.length) {
      const ppl = people(g.reimb);
      const L = [{ icon: "check", html: day + " 代墊款已匯出：" + ppl.length + " 人、" + g.reimb.length + " 筆，合計 " + esc(money(sum(g.reimb))) }];
      ppl.forEach((p) => L.push({ html: "• " + mention("@" + p.name) + "　" + p.items.length + " 筆　" + esc(money(sum(p.items))) }));
      L.push(link);
      cards.push(slackCard(ANNOUNCE_CHANNEL, L, "代墊款已匯出"));
    }
    if (ext.length) {
      const L = [{ icon: "check", html: day + " 廠商款已匯出：" + ext.length + " 筆，合計 " + esc(money(sum(ext))) }];
      ext.forEach((r) => L.push({ html: "• " + esc(r.payee || r.vendor || "") + "｜" + esc(r.purpose || "") + "｜" + esc(money(r.amount)) + "（提交人 " + mention("@" + (r.uploader || "")) + "）" }));
      L.push(link);
      cards.push(slackCard(ANNOUNCE_CHANNEL, L, "廠商款已匯出"));
    }
    const monthly = b.type === "20號";
    const n = cards.length + (monthly ? 1 : 0);
    let h = '<h2 class="fo-h3">會發出的通知（' + n + " 則）</h2>";
    if (!n) h += '<p class="fo-muted">這一批沒有要發的通知。</p>';
    h += cards.join("");
    if (monthly) h += '<p class="fo-note fo-note-info">20 號那批還會另外發一則本月付款總結（' + ANNOUNCE_CHANNEL + "，列出三個中心這個月已付款的筆數和金額）。</p>";
    return h;
  }

  function paintConfirm(id, opts) {
    const { batch: b, records } = S.batches[id];
    const ui = uiOf(id);
    if (ui.paidDate == null) ui.paidDate = b.payDate || "";
    const canAct = isAccountant();
    const paid = paidRecords(b, records);
    const held = heldRecords(b, records);
    const salary = num(b.salaryTotal);
    let h = stepsBar(4);
    h += '<section class="fo-banner fo-banner-green" role="status"><p class="fo-banner-title">' + ICON_CHECK + esc(shortName(b.releasedByName) || RELEASER) + "已放行" +
      (b.releasedAt ? "（" + esc(mdhm(b.releasedAt)) + "）" : "") + "</p>" +
      "<p>放行 " + paid.length + " 筆" + (salary ? "＋薪資" : "") + "，合計 " + money(sum(paid) + salary) + "。</p>";
    if (held.length) {
      h += '<div class="fo-held"><p class="fo-held-title">不放行 ' + held.length + " 筆，已移出這批（下一批會再列出，預設不勾）</p><ul>" +
        held.map((r) => "<li>" + esc(recordLine(r)) + '<span class="fo-held-reason">原因：' + esc(heldMap(b)[r.id] || "") + "</span></li>").join("") + "</ul></div>";
    }
    h += "</section>";
    h += '<section class="fo-card"><h1 class="fo-h1">確認已付款</h1>' +
      '<p class="fo-lead">到兆豐確認交易都成功後，填上實際匯出日期再按下面的按鈕。系統會在總表填上付款日期、發出下面這幾則通知，然後進到第 5 步記到藍途。</p>';
    if (!canAct) h += roleHint();
    h += '<label class="fo-label" for="foPaidDate">實際匯出日期</label>' +
      '<input type="date" class="fo-input fo-input-date" id="foPaidDate" data-act="paidDate" data-fk="paidDate" value="' + esc(ui.paidDate) + '"' + (canAct ? "" : " disabled") + ">";
    h += '<div id="foMsgs4">' + msgs4Html(b, paid, ui.paidDate) + "</div>";
    h += errBox("confirm");
    h += '<div class="fo-actions"><button type="button" class="fo-btn fo-btn-primary" id="foConfirmPaid" data-act="confirmPaid" data-fk="act:confirmPaid"' +
      (canAct && DATE_RE.test(ui.paidDate) && !S.busy ? "" : " disabled") + ">" + busyLabel("confirm", "確認已付款並發出通知") + "</button></div>";
    if (canAct && !DATE_RE.test(ui.paidDate)) h += '<p class="fo-hint fo-right-text" id="foPaidDateHint">請先填實際匯出日期。</p>';
    h += "</section>";
    paint(h, opts);
  }

  async function actConfirmPaid() {
    const id = S.route.id;
    const entry = S.batches[id];
    const ui = uiOf(id);
    if (!entry || !isAccountant() || S.busy || !DATE_RE.test(ui.paidDate || "")) return;
    const token = S.token;
    S.busy = "confirm";
    S.err = null;
    repaint();
    try {
      const res = await api("financeConfirmPaid", { batchId: id, paidDate: ui.paidDate });
      S.busy = "";
      S.confirmed[id] = { posted: arr(res.posted), warnings: arr(res.warnings) };
      entry.batch = res.batch || Object.assign({}, entry.batch, { status: "已付款", paidDate: ui.paidDate });
      S.overview = null;
      toast("已確認付款，通知已發出");
      announce("已確認付款。第 5 步：記到藍途");
      if (token !== S.token) return;
      window.scrollTo(0, 0);
      paintBatch(id, { focusHeading: true });
    } catch (e) {
      S.busy = "";
      if (token !== S.token) return;
      S.err = { where: "confirm", text: e.message };
      repaint();
    }
  }

  // ⑤ 記到藍途
  function fileListHtml(rows, ui) {
    const withFile = rows.filter((x) => x.r.hasFile);
    const files = ui.files || {};
    const known = withFile.filter((x) => files[x.r.id] && files[x.r.id].size != null);
    const total = known.reduce((t, x) => t + files[x.r.id].size, 0);
    let h = '<div class="fo-files"><div class="fo-files-head"><span id="foFilesH">ZIP 裡面的檔案（照匯入檔順序）</span><span>' + withFile.length + " 個檔案" +
      (known.length ? "・約 " + fmtSize(total) : "") + "</span></div>" +
      '<ol class="fo-files-list" role="list" aria-labelledby="foFilesH" tabindex="0">';
    rows.forEach((x) => {
      if (!x.r.hasFile) {
        h += '<li class="fo-file is-nofile"><span class="fo-file-name">' + x.nn + "　" + esc(x.r.purpose || x.r.vendor || "") + "（沒有單據，匯入檔照樣有這一筆）</span><span class=\"fo-file-size\">—</span></li>";
        return;
      }
      const info = files[x.r.id];
      const size = info && info.size != null ? info.size : null;
      const big = size != null && size > ATTACH_LIMIT;
      h += '<li class="fo-file' + (big ? " is-big" : "") + (info && info.error ? " is-failed" : "") + '"><span class="fo-file-name">' + esc(info && info.name ? info.name : zipEntryName(x, null)) +
        (big ? " " + chip("超過 5 MB", "red") : "") + (info && info.error ? " " + chip("沒抓到", "red") : "") + '</span><span class="fo-file-size">' + esc(fmtSize(size)) + "</span></li>";
    });
    return h + "</ol></div>";
  }

  function paintBlueway(id, opts) {
    const { batch: b, records } = S.batches[id];
    const ui = uiOf(id);
    const done = b.status === "已完成";
    const canAct = isAccountant();
    const paidDate = b.paidDate || b.payDate;
    const paid = paidRecords(b, records);
    const rows = importRows(paid);
    const withFile = rows.filter((x) => x.r.hasFile);
    const conf = S.confirmed[id];
    const heldN = heldRecords(b, records).length;
    const label = batchLabel(b.payDate, b.type);
    const zipState = ui.zip ? ui.zip.state : "";
    let h = stepsBar(5, { allDone: done });

    h += '<section class="fo-banner fo-banner-green" role="status"><p class="fo-banner-title">' + ICON_CHECK + esc(label) + "付款完成</p><ul class=\"fo-ul fo-mb0\">" +
      "<li>已在總表填入 " + paid.length + " 筆付款日期（" + esc(paidDate) + "），各中心審核表也會一起更新</li>";
    if (conf) conf.posted.forEach((t) => { h += "<li>已發送「" + esc(t) + "」到 " + ANNOUNCE_CHANNEL + "</li>"; });
    else h += "<li>付款通知已發到 " + ANNOUNCE_CHANNEL + "</li>";
    h += "<li>同仁打開「上傳紀錄」，會看到這幾筆變成「已匯出」</li>";
    if (heldN) h += "<li>" + esc(shortName(b.releasedByName) || RELEASER) + "不放行的 " + heldN + " 筆已移出這批，下一批會再列出，旁邊顯示原因</li>";
    h += "</ul>";
    if (conf && conf.warnings.length) h += '<p class="fo-note fo-note-amber"><strong>有些通知沒有發出去：</strong>' + conf.warnings.map(esc).join("；") + "</p>";
    if (done) h += '<p class="fo-mt">這一批在 ' + esc(mdhm(b.doneAt) || "") + " 完成，下面的檔案還是可以再下載。</p>";
    h += "</section>";

    h += '<section class="fo-card"><h1 class="fo-h1">記到藍途</h1>' +
      '<p class="fo-lead">藍途要手動上傳：先匯入記帳資料，再把憑證一筆一筆上傳成附件。下面兩個檔案的順序是對齊的，憑證檔名開頭的編號就是匯入檔的第幾筆。</p><div class="fo-picks">';

    // 第一個檔案：藍途匯入檔
    const parts = chunk(rows, IMPORT_MAX_ROWS);
    const noGl = paid.filter((r) => !String(r.glCodeNexTrek || "").trim()).length;
    h += '<div class="fo-box fo-box-flex"><p class="fo-kicker">第一個檔案</p><h2 class="fo-h3 fo-mt0">藍途匯入檔（Excel）</h2>' +
      '<p class="fo-body">共 ' + paid.length + " 筆，收付日期 " + esc(paidDate) + "。欄位照藍途的匯入範本排（暫定格式），下載後到藍途「匯入」上傳。</p>";
    if (parts.length > 1) {
      h += '<p class="fo-body">超過 ' + IMPORT_MAX_ROWS + " 筆，分成 " + parts.length + " 個檔案，照順序匯入：</p>";
      parts.forEach((p, i) => {
        h += '<button type="button" class="fo-btn fo-btn-primary fo-btn-block fo-mb" data-act="dlImport" data-part="' + i + '" data-fk="act:dlImport:' + i + '"' + (S.busy === "dlImport" ? " disabled" : "") +
          ">下載第 " + (i + 1) + " 個（第 " + p[0].no + "–" + p[p.length - 1].no + " 筆）</button>";
      });
    } else {
      h += '<button type="button" class="fo-btn fo-btn-primary fo-btn-block" data-act="dlImport" data-part="0" data-fk="act:dlImport:0"' + (S.busy === "dlImport" || !rows.length ? " disabled" : "") + ">" +
        busyLabel("dlImport", "下載藍途匯入檔", "產生檔案中…") + "</button>";
    }
    if (ui.importFiles && ui.importFiles.length) h += '<p class="fo-ok">已下載 ' + esc(ui.importFiles.join("、")) + "</p>";
    h += errBox("dlImport");
    h += noGl
      ? '<p class="fo-note fo-note-amber">有 ' + noGl + " 筆還沒有會計項目代碼（會計科目還沒對到藍途代碼），匯入藍途前請在 Excel 補上。</p>"
      : '<p class="fo-note fo-note-grey">會計項目代碼依「會計科目設定」的藍途代碼帶入。</p>';
    h += "</div>";

    // 第二個檔案：憑證 ZIP
    const files = ui.files || {};
    const sizes = withFile.map((x) => files[x.r.id] && files[x.r.id].size).filter((s) => s != null);
    const big = withFile.filter((x) => files[x.r.id] && files[x.r.id].size > ATTACH_LIMIT);
    const failed = withFile.filter((x) => files[x.r.id] && files[x.r.id].error);
    const working = zipState === "working";
    const zipLabel = working ? "打包中 " + ui.zip.done + "/" + ui.zip.total : (withFile.length ? "一鍵下載本批所有憑證" : "這一批沒有單據檔案");
    h += '<div class="fo-box fo-box-flex"><p class="fo-kicker">第二個檔案</p><h2 class="fo-h3 fo-mt0">本批所有憑證（ZIP）</h2>' +
      '<p class="fo-body">共 ' + withFile.length + " 個檔案" + (sizes.length === withFile.length && sizes.length ? "（約 " + fmtSize(sizes.reduce((t, s) => t + s, 0)) + "）" : "") +
      "。檔名開頭的編號對應匯入檔的第幾筆，上傳附件時照順序對就好。</p>" +
      '<button type="button" class="fo-btn fo-btn-primary fo-btn-block" id="foZipBtn" data-act="dlZip" data-fk="act:dlZip"' +
      (!withFile.length ? " disabled" : (working ? ' aria-disabled="true"' : "")) + ">" + esc(zipLabel) + "</button>" +
      '<div class="fo-progress" id="foZipBar"' + (working ? "" : " hidden") + ' aria-hidden="true"><span style="width:' +
      (working && ui.zip.total ? Math.round(100 * (ui.zip.done - 1) / ui.zip.total) : 0) + '%"></span></div>';
    if (ui.zipName) h += '<p class="fo-ok">已下載 ' + esc(ui.zipName) + "</p>";
    if (failed.length) h += '<p class="fo-note fo-note-amber">有 ' + failed.length + " 個檔案沒抓到（編號 " + failed.map((x) => x.nn).join("、") + "），ZIP 裡少了這幾個。可以再按一次重新打包。</p>";
    h += errBox("dlZip");
    if (big.length) h += '<p class="fo-note fo-note-amber">有 ' + big.length + " 個檔案超過 5 MB（藍途附件上限），上傳前要先壓縮：編號 " + big.map((x) => x.nn).join("、") + "。</p>";
    else if (sizes.length && sizes.length === withFile.length) h += '<p class="fo-note fo-note-green">每個檔案都在 5 MB 以內（藍途附件上限），上傳時不用再壓縮。</p>';
    else h += '<p class="fo-note fo-note-grey">藍途附件上限 5 MB，打包時會標出超過的檔案。</p>';
    h += "</div></div>";

    h += fileListHtml(rows, ui);

    if (!done) {
      h += '<div class="fo-finish"><p class="fo-h3 fo-mt0">上傳到藍途之後打勾</p>' +
        '<label class="fo-check-line"><input type="checkbox" class="fo-checkbox" data-act="chkImport" data-fk="chkImport"' + (ui.chkImport ? " checked" : "") + (canAct ? "" : " disabled") + "><span>記帳資料已經匯入藍途</span></label>" +
        '<label class="fo-check-line"><input type="checkbox" class="fo-checkbox" data-act="chkFiles" data-fk="chkFiles"' + (ui.chkFiles ? " checked" : "") + (canAct ? "" : " disabled") + "><span>附件都上傳到藍途了</span></label></div>";
      if (!canAct) h += roleHint();
      h += errBox("complete");
      h += '<div class="fo-actions"><button type="button" class="fo-btn fo-btn-primary" id="foComplete" data-act="complete" data-fk="act:complete"' +
        (canAct && ui.chkImport && ui.chkFiles && !S.busy ? "" : " disabled") + ">" + busyLabel("complete", "完成本批，回到批次列表") + "</button></div>";
    } else {
      h += '<div class="fo-actions"><a class="fo-btn fo-btn-secondary" href="#finance/ops/batches" data-fk="back">回到批次列表</a></div>';
    }
    h += "</section>";
    paint(h, opts);
  }

  async function actComplete() {
    const id = S.route.id;
    const entry = S.batches[id];
    const ui = uiOf(id);
    if (!entry || !isAccountant() || S.busy || !ui.chkImport || !ui.chkFiles) return;
    const token = S.token;
    S.busy = "complete";
    S.err = null;
    repaint();
    try {
      await api("financeCompleteBatch", { batchId: id });
      S.busy = "";
      delete S.ui[id];
      delete S.confirmed[id];
      S.overview = null;
      toast(batchLabel(entry.batch.payDate, entry.batch.type) + "已完成");
      if (token === S.token) go("batches");
    } catch (e) {
      S.busy = "";
      if (token !== S.token) return;
      S.err = { where: "complete", text: e.message };
      repaint();
    }
  }

  /* ---------------- 產生檔案（瀏覽器裡做，不經過後端） ---------------- */
  const libLoads = {};
  function loadLib(url, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!libLoads[url]) {
      libLoads[url] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.async = true;
        const fail = () => { delete libLoads[url]; s.remove(); reject(new Error("產生檔案的工具載入失敗，請確認網路連線後再試一次。")); };
        s.onload = () => (window[globalName] ? resolve(window[globalName]) : fail());
        s.onerror = fail;
        document.head.appendChild(s);
      });
    }
    return libLoads[url];
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }
  // 代碼、帳號、發票號碼一律存成「文字」格存（開頭的 0 才不會不見）
  function textCols(X, ws, cols, rowCount) {
    for (let r = 1; r < rowCount; r++) {
      cols.forEach((c) => {
        const cell = ws[X.utils.encode_cell({ r, c })];
        if (cell && cell.v !== "" && cell.v != null) { cell.t = "s"; cell.v = String(cell.v); cell.z = "@"; delete cell.w; }
      });
    }
  }
  function blank(v) { return v === "" || v == null ? null : v; }

  async function buildBankFile(o) {
    const X = await loadLib(XLSX_URL, "XLSX");
    const g = groupOf(o.records);
    const ppl = people(g.reimb);
    const wb = X.utils.book_new();

    const t = [BANK_HEADER.slice()];
    g.transfer.forEach((r, i) => t.push([i + 1, blank(digitsText(r.branch)), blank(digitsText(r.account)), r.accountName || r.payee || r.vendor || "", num(r.amount), cut(r.purpose || "", 20), r.uploader || "", String(r.id)]));
    const ws1 = X.utils.aoa_to_sheet(t);
    textCols(X, ws1, [1, 2, 7], t.length);
    ws1["!cols"] = [{ wch: 6 }, { wch: 18 }, { wch: 20 }, { wch: 28 }, { wch: 10 }, { wch: 26 }, { wch: 10 }, { wch: 22 }];
    X.utils.book_append_sheet(wb, ws1, "廠商匯款");

    const p = [REIMB_HEADER.slice()];
    ppl.forEach((x, i) => p.push([i + 1, x.name, sum(x.items), x.items.length, x.items.map((r) => (r.purpose || r.vendor || "") + " " + fmtNum(r.amount)).join("；")]));
    const ws2 = X.utils.aoa_to_sheet(p);
    ws2["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 60 }];
    X.utils.book_append_sheet(wb, ws2, "代墊款（每人合計）");

    const lines = [
      "這是暫定格式：拿到兆豐的匯入範本後，會改成可以直接匯入的格式。",
      "付款日：" + o.payDate + "（" + batchLabel(o.payDate, o.type) + "）",
      "廠商匯款：" + g.transfer.length + " 筆，" + money(sum(g.transfer)) + "。照「廠商匯款」工作表，在兆豐企業網銀的整批付款建檔。",
      "代墊款：" + ppl.length + " 人、" + g.reimb.length + " 筆，" + money(sum(g.reimb)) + "。每人合計一筆，跟薪資一起匯（見「代墊款（每人合計）」工作表）。",
    ];
    if (o.type === "5號" || o.salary) lines.push("薪資：用 Swingvy 的薪轉檔，不在這個檔案裡。");
    if (g.bill.length) lines.push("繳費單 " + g.bill.length + " 筆（" + money(sum(g.bill)) + "）：用網銀的繳費功能另外繳，不在這個檔案裡。");
    const legacyN = g.transfer.filter((r) => r.legacy || !r.account).length;
    if (legacyN) lines.push("有 " + legacyN + " 筆是舊格式，沒有收款帳號，要在兆豐自己補上。");
    lines.push("收款銀行代碼、收款帳號都是文字格式，開頭的 0 不會不見。");
    const ws3 = X.utils.aoa_to_sheet([["說明"]].concat(lines.map((l) => [l])));
    ws3["!cols"] = [{ wch: 90 }];
    X.utils.book_append_sheet(wb, ws3, "說明");

    const name = ymd(o.payDate) + "_兆豐匯入檔（暫定格式）.xlsx";
    saveBlob(new Blob([X.write(wb, { bookType: "xlsx", type: "array" })], { type: XLSX_MIME }), name);
    return name;
  }

  function importRow(r, paidDate) {
    const note = cut((r.purpose || "") + "（" + (r.project ? r.project + "，" : "") + "上傳人 " + (r.uploader || "") + "）", 300);
    return [paidDate, blank(r.invoiceDate), num(r.amount), null, note, blank(String(r.glCodeNexTrek || "").trim()), null, null,
      blank(String(r.invoiceNumber || "").trim()), blank(cut(r.payee || r.vendor || "", 30)), blank(cut(r.center || "", 30)), blank(cut(r.project || "", 30)), blank(cut(r.budgetItem || "", 30)), null, null];
  }

  async function buildImportFile(paidDate, rows, partIndex, partCount) {
    const X = await loadLib(XLSX_URL, "XLSX");
    const aoa = [IMPORT_HEADER.slice()].concat(rows.map((x) => importRow(x.r, paidDate)));
    const ws = X.utils.aoa_to_sheet(aoa);
    textCols(X, ws, [0, 1, 5, 8], aoa.length);
    ws["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 48 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 8 }];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, "匯入資料");
    const name = ymd(paidDate) + "_藍途匯入（暫定格式）" + (partCount > 1 ? "_" + (partIndex + 1) : "") + ".xlsx";
    saveBlob(new Blob([X.write(wb, { bookType: "xlsx", type: "array" })], { type: XLSX_MIME }), name);
    return name;
  }

  async function actDownloadBank() {
    if (S.busy) return;
    const route = S.route;
    let o;
    let after;
    if (route.page === "send") {
      const d = S.drafts[route.date];
      if (!d) return;
      o = { payDate: route.date, type: d.type, records: selectedRecords(d), salary: d.type === "5號" ? toInt(d.salary) : 0 };
      after = (name) => { d.bankFile = name; };
    } else if (route.page === "batch" && S.batches[route.id]) {
      const { batch: b, records } = S.batches[route.id];
      o = { payDate: b.payDate, type: b.type, records, salary: num(b.salaryTotal) };
      after = (name) => { uiOf(route.id).bankFile = name; };
    } else return;
    const token = S.token;
    S.busy = "dlBank";
    S.err = null;
    repaint();
    try {
      const name = await buildBankFile(o);
      S.busy = "";
      after(name);
      announce("已下載 " + name);
    } catch (e) {
      S.busy = "";
      S.err = { where: "dlBank", text: "兆豐匯入檔沒有產生成功：" + e.message };
    }
    if (token === S.token) repaint();
  }

  async function actDownloadImport(partIndex) {
    const id = S.route.id;
    const entry = S.batches[id];
    if (!entry || S.busy) return;
    const b = entry.batch;
    const paidDate = b.paidDate || b.payDate;
    const parts = chunk(importRows(paidRecords(b, entry.records)), IMPORT_MAX_ROWS);
    const part = parts[partIndex || 0];
    if (!part) return;
    const token = S.token;
    S.busy = "dlImport";
    S.err = null;
    repaint();
    try {
      const name = await buildImportFile(paidDate, part, partIndex || 0, parts.length);
      S.busy = "";
      const ui = uiOf(id);
      ui.importFiles = uniq(arr(ui.importFiles).concat([name]));
      announce("已下載 " + name);
    } catch (e) {
      S.busy = "";
      S.err = { where: "dlImport", text: "藍途匯入檔沒有產生成功：" + e.message };
    }
    if (token === S.token) repaint();
  }

  function updateZipProgress(id) {
    if (S.route.page !== "batch" || S.route.id !== id) return;
    const ui = uiOf(id);
    const btn = document.getElementById("foZipBtn");
    if (btn && ui.zip) btn.textContent = ui.zip.label || "打包中 " + ui.zip.done + "/" + ui.zip.total;
    const bar = document.getElementById("foZipBar");
    if (bar && ui.zip && ui.zip.total) {
      bar.hidden = false;
      const fill = bar.querySelector("span");
      if (fill) fill.style.width = Math.round(100 * (ui.zip.label ? 1 : (ui.zip.done - 1) / ui.zip.total)) + "%";
    }
  }

  async function actDownloadZip() {
    const id = S.route.id;
    const entry = S.batches[id];
    if (!entry) return;
    const ui = uiOf(id);
    if (ui.zip && ui.zip.state === "working") return;
    const b = entry.batch;
    const rows = importRows(paidRecords(b, entry.records)).filter((x) => x.r.hasFile);
    if (!rows.length) return;
    const showing = () => S.route.page === "batch" && S.route.id === id;
    ui.zip = { state: "working", done: 1, total: rows.length };
    ui.files = {};
    ui.zipName = "";
    if (S.err && S.err.where === "dlZip") S.err = null;
    if (showing()) repaint();
    announce("開始打包 " + rows.length + " 個檔案");
    try {
      const JSZip = await loadLib(JSZIP_URL, "JSZip");
      const zip = new JSZip();
      let okCount = 0;
      let bytesTotal = 0;
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i];
        ui.zip.done = i + 1;
        updateZipProgress(id);
        try {
          const f = await api("financeFile", { batchId: id, recordId: x.r.id });
          const bytes = b64ToBytes(f.base64);
          const name = zipEntryName(x, f);
          zip.file(name, bytes, { binary: true });
          ui.files[x.r.id] = { name, size: bytes.length };
          okCount++;
          bytesTotal += bytes.length;
        } catch (e) {
          ui.files[x.r.id] = { name: zipEntryName(x, null), size: null, error: e.message || "下載失敗" };
        }
      }
      if (!okCount) throw new Error("一個檔案都沒有抓到，請稍後再試一次。");
      ui.zip.label = "壓縮中…";
      updateZipProgress(id);
      // 照片、PDF 本身已經壓縮過，用「只打包不壓縮」比較快
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const zipName = ymd(b.paidDate || b.payDate) + "_付款批次憑證.zip";
      saveBlob(blob, zipName);
      ui.zip = { state: "done" };
      ui.zipName = zipName;
      ui.zipBytes = bytesTotal;
      const failedN = rows.length - okCount;
      announce("已下載 " + zipName + (failedN ? "，有 " + failedN + " 個檔案沒抓到" : ""));
    } catch (e) {
      ui.zip = { state: "error" };
      if (showing()) S.err = { where: "dlZip", text: "憑證打包失敗：" + e.message };
    }
    if (showing()) repaint();
  }

  /* ============================================================
     待放行（放行人）
     ============================================================ */
  async function pageRelease(route, token, isNav) {
    if (isNav) paintLoading();
    const ov = await getOverview(true);
    if (token !== S.token) return;
    renderSubnav();
    const pending = ov.activeBatches.filter((b) => b.status === "待放行");
    let id = route.id;
    if (!id && pending.length === 1 && !S.relResult) id = pending[0].id;
    if (id) {
      await loadBatch(id);
      if (token !== S.token) return;
      if (!S.rel || S.rel.batchId !== id) S.rel = { batchId: id, held: {}, confirmed: false, returnOpen: false, returnReason: "" };
      S.view = (o) => paintReleaseDetail(id, o);
      paintReleaseDetail(id, { focusHeading: isNav });
    } else {
      S.view = (o) => paintReleaseList(pending, o);
      paintReleaseList(pending, S.relResult ? { focus: "relResult" } : { focusHeading: isNav });
    }
  }

  function relResultHtml() {
    const x = S.relResult;
    if (!x) return "";
    const b = x.batch;
    const label = batchLabel(b.payDate, b.type);
    const acc = shortName(b.sentByName) || ACCOUNTANT;
    const heldRecs = x.records.filter((r) => has(x.held, r.id));
    const relRecs = x.records.filter((r) => !has(x.held, r.id));
    const salary = num(b.salaryTotal);
    const items = [];
    if (x.kind === "released") {
      items.push("放行 " + relRecs.length + " 筆" + (salary ? "＋薪資" : "") + "，合計 " + money(sum(relRecs) + salary) + "。總表會記下放行的人和時間。");
      items.push("已在 " + FIN_CHANNEL + " 通知 @" + acc + " 確認匯款結果，" + acc + "的第 4 步「確認已付款」現在打開了。");
      if (heldRecs.length) {
        items.push("不放行的 " + heldRecs.length + " 筆已移出這批，原因寫進總表；已在 #組織布告欄 通知 " + uniq(heldRecs.map((r) => "@" + (r.uploader || personOf(r)))).join("、") + "。");
        items.push("下一批產生時，這 " + heldRecs.length + " 筆會再列出來，預設不勾，旁邊顯示你寫的原因。");
      }
      return '<section class="fo-banner fo-banner-green" role="status"><p class="fo-banner-title" tabindex="-1" data-fk="relResult">' + ICON_CHECK + "已放行 " + esc(label) + "</p>" +
        '<ul class="fo-ul">' + items.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" +
        '<div class="fo-actions fo-actions-start"><a class="fo-btn fo-btn-secondary" href="#finance/ops/batch/' + encodeURIComponent(b.id) + '">看這一批的付款進度</a></div></section>';
    }
    items.push("這批回到" + acc + "的第 2 步「核對清單」，" + acc + "改好兆豐的檔案後，會再送一次放行請求。");
    items.push("已在 " + FIN_CHANNEL + " 通知 @" + acc + "，附上你寫的原因：" + x.reason);
    if (heldRecs.length) items.push("你標了不放行的 " + heldRecs.length + " 筆，回到清單時會先取消勾選，旁邊顯示原因。");
    return '<section class="fo-banner fo-banner-red" role="status"><p class="fo-banner-title" tabindex="-1" data-fk="relResult">已退回給' + esc(acc) + "（" + esc(label) + "）</p>" +
      '<ul class="fo-ul fo-mb0">' + items.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul></section>";
  }

  function paintReleaseList(pending, opts) {
    let h = relResultHtml();
    h += '<section class="fo-card"><h1 class="fo-h1">待放行</h1>';
    if (!isReleaser()) h += roleHint("只有放行人可以操作");
    if (!pending.length) {
      h += '<p class="fo-lead fo-mb0">目前沒有等你放行的批次。會計送出放行請求時，會在 ' + FIN_CHANNEL + " tag 你。</p>";
    } else {
      h += '<p class="fo-lead">會計送出的付款批次。打開一批，對照兆豐網銀的待放行交易，放行之後回來按「確認放行」。</p><ul class="fo-blist">';
      pending.forEach((b) => {
        const label = batchLabel(b.payDate, b.type);
        h += '<li class="fo-brow"><div class="fo-brow-main"><div class="fo-brow-title"><strong>' + esc(label) + "</strong>" + chip(isOwn(b) ? "你送出的" : "等你放行", "amber") + "</div>" +
          '<div class="fo-muted">' + esc(batchSumText(b)) + '</div><div class="fo-muted">' + esc((shortName(b.sentByName) || ACCOUNTANT) + " " + mdhm(b.sentAt) + " 送出放行請求") + "</div></div>" +
          '<a class="fo-btn fo-btn-primary" href="#finance/ops/release/' + encodeURIComponent(b.id) + '" data-fk="rel:' + esc(b.id) + '">開始核對<span class="fo-sr">（' + esc(label) + "）</span></a></li>";
      });
      h += "</ul>";
    }
    h += "</section>";
    paint(h, opts);
  }

  function relState(id) {
    const entry = S.batches[id];
    const b = entry.batch;
    const recs = entry.records;
    const R = S.rel;
    const isHeld = (r) => has(R.held, r.id);
    const heldRecs = recs.filter(isHeld);
    const missing = heldRecs.filter((r) => !String(R.held[r.id] || "").trim());
    const own = isOwn(b);
    const can = isReleaser() && !own && b.status === "待放行";
    const heldReimb = heldRecs.some((r) => r.group === "reimb");
    return {
      b, recs, R, isHeld, heldRecs, missing, own, can, heldReimb,
      rel: recs.filter((r) => !isHeld(r)),
      salary: num(b.salaryTotal),
      canRelease: can && !S.busy && R.confirmed && !missing.length && !heldReimb,
      canReturn: can && !S.busy && !!String(R.returnReason || "").trim() && !missing.length,
    };
  }

  function tilesHtml(st) {
    const relOf = (g) => st.rel.filter((r) => r.group === g);
    const heldN = (g) => st.heldRecs.filter((r) => r.group === g).length;
    const note = (g) => (heldN(g) ? "，不放行 " + heldN(g) + " 筆" : "");
    const rr = relOf("reimb");
    const tiles = [
      { label: "薪資＋代墊款", amount: st.salary + sum(rr), sub: "薪資 " + fmtNum(st.salary) + "＋代墊款 " + fmtNum(sum(rr)) + "（" + people(rr).length + " 人 " + rr.length + " 筆" + note("reimb") + "）" },
      { label: "廠商匯款", amount: sum(relOf("transfer")), sub: relOf("transfer").length + " 筆" + note("transfer") },
      { label: "網銀代繳", amount: sum(relOf("bill")), sub: relOf("bill").length + " 筆" + note("bill") },
      { label: "本次放行合計", amount: st.salary + sum(st.rel), sub: "兆豐網銀放行的總額要和這個一樣", main: true },
    ];
    return tiles.map((t) => '<div class="fo-tile' + (t.main ? " is-main" : "") + '"><div class="fo-tile-label">' + esc(t.label) + '</div><div class="fo-tile-amt">' + money(t.amount) +
      '</div><div class="fo-tile-sub">' + esc(t.sub) + "</div></div>").join("");
  }

  function relRow(r, st) {
    const held = st.isHeld(r);
    const reason = held ? String(st.R.held[r.id] || "") : "";
    const who = r.group === "reimb" ? personOf(r) : (r.payee || r.vendor || "");
    const dis = st.can && !S.busy ? "" : " disabled";
    const rid = esc(r.id);
    let tags = "";
    if (r.fixedExpense) tags += chip("每月固定支出", "navy");
    if (r.firstTime) tags += chip("第一次匯給這個帳號", "red");
    if (r.urgent) tags += chip("緊急", "red");
    if (r.group === "bill") tags += dueChip(r, st.b.payDate);
    let h = '<div class="fo-rrow' + (held ? " is-held" : "") + '" data-rid="' + rid + '"><div class="fo-rrow-main"><div class="fo-rrow-info">' +
      '<div class="fo-rrow-title">' + esc(r.group === "reimb" ? r.purpose || "" : who + "｜" + (r.purpose || "")) + "</div>" +
      '<div class="fo-rrow-sub">' + esc(r.group === "reimb" ? (r.center || "—") + "・單據日期 " + (r.invoiceDate || "—") : "提交人 " + (r.uploader || "—") + "・" + (r.center || "—")) + "</div>";
    if (r.group === "transfer") {
      h += '<div class="fo-rrow-bank">' + (r.legacy || !r.account
        ? '<span class="fo-legacy">舊格式，沒有完整帳號：「' + esc(r.paymentDetail || "（空白）") + "」</span>"
        : esc(r.bankName || "") + '　<span class="fo-mono">' + esc(fmtBranch(r.branch)) + '</span><span class="fo-mono fo-acct">' + groupDigits(r.account) + "</span>") + "</div>";
    }
    h += '<div class="fo-tags">' + tags + fileLink(r, who + " " + (r.purpose || "")) + "</div></div>" +
      '<div class="fo-rrow-amt">' + money(r.amount) + (held ? '<span class="fo-sr">（不放行）</span>' : "") + "</div>" +
      '<div class="fo-seg" role="group" aria-label="' + esc("要不要放行：" + who + " " + (r.purpose || "")) + '">' +
      '<button type="button" class="fo-seg-btn' + (held ? "" : " is-on") + '" aria-pressed="' + !held + '" data-act="relOn" data-id="' + rid + '" data-fk="relOn:' + rid + '"' + dis + ">放行</button>" +
      '<button type="button" class="fo-seg-btn fo-seg-hold' + (held ? " is-on" : "") + '" aria-pressed="' + held + '" data-act="relOff" data-id="' + rid + '" data-fk="relOff:' + rid + '"' + dis + ">不放行</button></div></div>";
    if (held) {
      h += '<div class="fo-reason"><label class="fo-reason-label" for="foReason-' + rid + '">不放行的原因（必填，上傳人會在 Slack 看到）</label>' +
        '<div class="fo-reason-chips">' + HOLD_CHIPS.map((c, i) => '<button type="button" class="fo-rchip' + (reason === c.text ? " is-on" : "") + '" aria-pressed="' + (reason === c.text) +
          '" data-act="relChip" data-id="' + rid + '" data-chip="' + i + '" data-fk="chip:' + rid + ":" + i + '"' + dis + ">" + esc(c.label) + "</button>").join("") + "</div>" +
        '<textarea class="fo-textarea" id="foReason-' + rid + '" rows="2" data-act="relReason" data-id="' + rid + '" data-fk="reason:' + rid + '"' + dis +
        ' placeholder="也可以自己寫，例如：發票抬頭不對，請廠商重開，下一批再付">' + esc(reason) + "</textarea></div>";
    }
    return h + "</div>";
  }

  function relGroupsHtml(st) {
    const g = groupOf(st.recs);
    let h = "";
    if (g.reimb.length) {
      h += '<section class="fo-card fo-card-tight" aria-labelledby="foRgReimb"><h2 class="fo-h2" id="foRgReimb">代墊款（跟薪資一起匯）</h2><p class="fo-muted fo-mb">匯到同仁在兆豐登記的帳號。</p>';
      people(g.reimb).forEach((p) => {
        const relMine = p.items.filter((r) => !st.isHeld(r));
        const k = p.items.length - relMine.length;
        h += '<div class="fo-rperson"><div class="fo-person-head"><span>' + esc(p.name) + "</span><span>" + relMine.length + " 筆・" + money(sum(relMine)) + (k ? "（不放行 " + k + " 筆）" : "") + "</span></div>" +
          p.items.map((r) => relRow(r, st)).join("") + "</div>";
      });
      h += "</section>";
    }
    if (g.transfer.length) {
      h += '<section class="fo-card fo-card-tight" aria-labelledby="foRgTr"><h2 class="fo-h2" id="foRgTr">匯款給廠商／外部個人</h2><p class="fo-muted fo-mb">完整帳號只在「財務作業」看得到，請和兆豐網銀的待放行交易逐筆對照。</p>' +
        g.transfer.map((r) => relRow(r, st)).join("") + "</section>";
    }
    if (g.bill.length) {
      h += '<section class="fo-card fo-card-tight" aria-labelledby="foRgBill"><h2 class="fo-h2" id="foRgBill">繳費單（網銀代繳）</h2><p class="fo-muted fo-mb">稅金、健保費這類繳費單，用網銀的繳費功能。</p>' +
        g.bill.map((r) => relRow(r, st)).join("") + "</section>";
    }
    return h;
  }

  function relInfoHtml(st) {
    const acc = shortName(st.b.sentByName) || ACCOUNTANT;
    let h = '<div class="fo-sumbar-label">本次放行</div><div class="fo-sumbar-big">' + st.rel.length + " 筆" + (st.salary ? "＋薪資" : "") + "・" + money(st.salary + sum(st.rel)) + "</div>";
    if (st.heldRecs.length) h += '<div class="fo-sumbar-sub fo-sumbar-warm">不放行 ' + st.heldRecs.length + " 筆・" + money(sum(st.heldRecs)) + "，會移出這批</div>";
    if (st.missing.length) h += '<p class="fo-bar-warn">還有 ' + st.missing.length + " 筆不放行沒寫原因。</p>";
    if (st.heldReimb) h += '<p class="fo-bar-warn" id="foHeldReimb">代墊款跟薪資是同一筆轉帳。不放行代墊款，要先請' + esc(acc) + "把兆豐裡那位同仁的金額改掉，請按「整批退回給會計」，這筆會排到下一循環。</p>";
    return h;
  }

  function paintReleaseDetail(id, opts) {
    const entry = S.batches[id];
    if (!entry || !S.rel) return;
    const st = relState(id);
    const b = st.b;
    const label = batchLabel(b.payDate, b.type);
    const acc = shortName(b.sentByName) || ACCOUNTANT;
    const pendingNow = b.status === "待放行";
    let h = '<section class="fo-card"><div class="fo-title-row"><h1 class="fo-h1">' + esc(label) + "：待放行</h1>" +
      (pendingNow ? chip(st.own ? "你送出的" : "等你放行", "amber") : statusChip(b.status)) + "</div>" +
      '<p class="fo-lead">' + esc(acc + " " + mdhm(b.sentAt) + " 送出放行請求，兆豐網銀已經匯入建檔。") + "</p>";
    if (st.own) h += '<p class="fo-callout fo-callout-amber">這一批是你送出的，要由另一位放行人放行</p>';
    else if (!isReleaser()) h += roleHint("只有放行人可以操作");
    else if (!pendingNow) h += '<p class="fo-callout">這一批已經是「' + esc(b.status) + '」，不用再放行。<a href="#finance/ops/batch/' + encodeURIComponent(b.id) + '">看這一批的付款進度</a></p>';
    h += '<ol class="fo-howto">' + ["對照兆豐網銀的待放行交易", "有問題的改成「不放行」並寫原因，兆豐那一筆也不放行", "兆豐其他筆放行後，回來按「確認放行」"]
      .map((t, i) => '<li><span class="fo-howto-num" aria-hidden="true">' + (i + 1) + "</span><span>" + esc(t) + "</span></li>").join("") + "</ol></section>";
    h += '<section class="fo-tiles" id="foTiles" aria-label="本批合計">' + tilesHtml(st) + "</section>";
    h += relGroupsHtml(st);
    const dis = st.can && !S.busy ? "" : " disabled";
    h += '<section class="fo-sumbar fo-relbar" aria-label="本次放行"><div id="foRelInfo" aria-live="polite">' + relInfoHtml(st) + "</div>" +
      '<label class="fo-check-line"><input type="checkbox" class="fo-checkbox" data-act="relConfirm" data-fk="relConfirm"' + (st.R.confirmed ? " checked" : "") + dis + ">" +
      "<span>我已經在兆豐網銀放行上面這些款項" + (st.heldRecs.length ? "（標了不放行的 " + st.heldRecs.length + " 筆，兆豐那邊也沒有放行）" : "") + "</span></label>" +
      errBox("release") +
      '<div class="fo-actions"><button type="button" class="fo-btn fo-btn-outline-light" data-act="returnOpen" data-fk="act:returnOpen" aria-expanded="' + !!st.R.returnOpen + '"' + dis + ">整批退回給會計</button>" +
      '<button type="button" class="fo-btn fo-btn-primary" id="foReleaseBtn" data-act="release" data-fk="act:release"' + (st.canRelease ? "" : " disabled") + ">" + busyLabel("release", "確認放行") + "</button></div>";
    if (st.can && !st.R.confirmed && !st.heldReimb) h += '<p class="fo-sumbar-hint" id="foReleaseWhy">勾了「我已經在兆豐網銀放行上面這些款項」才能確認放行。</p>';
    if (st.R.returnOpen && st.can) {
      h += '<div class="fo-returnbox" id="foReturnBox"><label class="fo-reason-label fo-red" for="foReturnReason">退回的原因（' + esc(acc) + "會在 Slack 看到）</label>" +
        '<textarea class="fo-textarea fo-textarea-plain" id="foReturnReason" rows="2" data-act="returnReason" data-fk="returnReason" placeholder="例如：兆豐建檔的總額比清單多 1,280 元，請核對後再送一次">' + esc(st.R.returnReason) + "</textarea>" +
        (st.missing.length ? '<p class="fo-hint">標了不放行的，要先寫原因才能退回。</p>' : "") + errBox("return") +
        '<div class="fo-actions"><button type="button" class="fo-btn fo-btn-secondary" data-act="returnCancel" data-fk="act:returnCancel">取消</button>' +
        '<button type="button" class="fo-btn fo-btn-danger" id="foReturnBtn" data-act="doReturn" data-fk="act:doReturn"' + (st.canReturn ? "" : " disabled") + ">" + busyLabel("return", "送出退回") + "</button></div></div>";
    }
    h += "</section>";
    paint(h, opts);
  }

  // 打字時不重畫整頁，只更新金額、提醒、按鈕
  function patchRelease(id) {
    if (!S.rel || S.rel.batchId !== id || !S.batches[id]) return;
    const st = relState(id);
    const tiles = document.getElementById("foTiles");
    if (tiles) tiles.innerHTML = tilesHtml(st);
    const info = document.getElementById("foRelInfo");
    if (info) info.innerHTML = relInfoHtml(st);
    const rb = document.getElementById("foReleaseBtn");
    if (rb) rb.disabled = !st.canRelease;
    const tb = document.getElementById("foReturnBtn");
    if (tb) tb.disabled = !st.canReturn;
  }

  function cleanHeld() {
    const out = {};
    Object.keys(S.rel.held).forEach((k) => { out[k] = String(S.rel.held[k] || "").trim(); });
    return out;
  }

  async function actReleaseOrReturn(kind) {
    const id = S.rel && S.rel.batchId;
    const entry = id && S.batches[id];
    if (!entry) return;
    const st = relState(id);
    if (kind === "release" ? !st.canRelease : !st.canReturn) return;
    const token = S.token;
    const held = cleanHeld();
    const reason = String(S.rel.returnReason || "").trim();
    S.busy = kind;
    S.err = null;
    repaint();
    try {
      const res = kind === "release"
        ? await api("financeRelease", { batchId: id, held })
        : await api("financeReturn", { batchId: id, reason, held });
      S.busy = "";
      S.relResult = { kind: kind === "release" ? "released" : "returned", batch: res.batch || entry.batch, records: entry.records, held, reason };
      S.rel = null;
      S.overview = null;
      toast(kind === "release" ? "已確認放行" : "已退回給會計");
      announce(kind === "release" ? "已放行 " + batchLabel(entry.batch.payDate, entry.batch.type) : "已退回給會計");
      if (token !== S.token) return;
      replaceRoute("release");
      window.scrollTo(0, 0);
      const t = ++S.token;
      run(S.route, t, false);
    } catch (e) {
      S.busy = "";
      if (token !== S.token) return;
      S.err = { where: kind, text: e.message };
      repaint();
    }
  }

  /* ============================================================
     單據完備
     ============================================================ */
  async function pageCompleteness(route, token, isNav) {
    if (isNav) paintLoading();
    const res = await api("financeCompleteness", {});
    if (token !== S.token) return;
    S.comp.records = arr(res.records).map((r) => Object.assign({}, r, { id: String(r.id) }));
    S.comp.pinned = {};
    S.comp.open = {};
    S.comp.err = {};
    S.comp.busy = {};
    S.view = paintCompleteness;
    paintCompleteness({ focusHeading: isNav });
  }

  function compState(r) { return r.complete ? "done" : (String(r.paperNote || "").trim() ? "issue" : "todo"); }
  function approvedText(r) {
    const when = r.reviewedAt ? md(String(r.reviewedAt).slice(0, 10)) : "";
    const who = shortName(r.reviewer || "");
    if (!when && !who) return "—";
    return (when || "") + (who ? "（" + who + "）" : "");
  }

  function compCard(r) {
    const C = S.comp;
    const st = compState(r);
    const id = esc(r.id);
    const dis = C.busy[r.id] ? " disabled" : "";
    const title = r.vendor || r.purpose || "（沒有店家名稱）";
    const url = safeUrl(r.fileUrl);
    let h = '<article class="fo-doc is-' + st + '" aria-labelledby="foDocH-' + id + '"><div class="fo-doc-file"><div class="fo-doc-filebox">' + ICON_FILE +
      '<span class="fo-doc-filename">' + esc(r.fileName || "憑證電子檔") + "</span></div>" +
      (url ? '<a class="fo-btn fo-btn-secondary fo-btn-block" href="' + esc(url) + '" target="_blank" rel="noopener" data-fk="file:' + id + '">開啟電子檔<span class="fo-sr">（' + esc(title) + "，另開新分頁）</span></a>"
        : '<p class="fo-muted fo-small">沒有電子檔連結</p>') + "</div>";
    h += '<div class="fo-doc-main"><div class="fo-doc-head"><h2 class="fo-h2" id="foDocH-' + id + '">' + esc(title) + '</h2><span class="fo-doc-amt">' + money(r.amount) + "</span></div>" +
      '<dl class="fo-dl"><dt>上傳人</dt><dd>' + esc(r.uploader || "—") + (r.center ? "（" + esc(r.center) + "）" : "") + "</dd>" +
      (r.project && r.project !== r.center ? "<dt>專案</dt><dd>" + esc(r.project) + "</dd>" : "") +
      "<dt>用途</dt><dd>" + esc(r.purpose || "—") + "</dd><dt>單據日期</dt><dd>" + esc(r.invoiceDate || "—") + "</dd>" +
      "<dt>發票號碼</dt><dd>" + esc(r.invoiceNumber || "（沒有發票號碼）") + "</dd><dt>主管核准</dt><dd>" + esc(approvedText(r)) + "</dd></dl>";
    if (st === "todo" && !C.open[r.id]) {
      h += '<div class="fo-actions fo-actions-start"><button type="button" class="fo-btn fo-btn-primary" data-act="paperOk" data-id="' + id + '" data-fk="ok:' + id + '"' + dis + ">紙本相符</button>" +
        '<button type="button" class="fo-btn fo-btn-danger-outline" data-act="paperIssue" data-id="' + id + '" data-fk="issue:' + id + '"' + dis + ">有問題</button></div>";
    } else if (st === "todo") {
      h += '<div class="fo-issue"><label class="fo-reason-label fo-red" for="foNote-' + id + '">哪裡有問題？（會通知上傳人補件）</label>' +
        '<textarea class="fo-textarea fo-textarea-red" id="foNote-' + id + '" rows="2" data-act="paperNote" data-id="' + id + '" data-fk="note:' + id + '"' + dis +
        ' placeholder="例如：紙本金額是 1,250，電子檔是 1,280，請確認">' + esc(C.notes[r.id] || "") + "</textarea>" +
        '<div class="fo-actions"><button type="button" class="fo-btn fo-btn-secondary" data-act="paperCancel" data-id="' + id + '" data-fk="cancel:' + id + '"' + dis + ">取消</button>" +
        '<button type="button" class="fo-btn fo-btn-danger" data-act="paperSave" data-id="' + id + '" data-fk="save:' + id + '"' + dis + ">" + (C.busy[r.id] ? "送出中…" : "送出並通知上傳人") + "</button></div></div>";
    } else if (st === "done") {
      h += '<div class="fo-docstate is-ok"><span>已核對：紙本相符（總表「單據完備」已打勾）</span>' +
        '<button type="button" class="fo-linkbtn" data-act="paperUndo" data-id="' + id + '" data-fk="undo:' + id + '"' + dis + ">復原</button></div>";
    } else {
      h += '<div class="fo-docstate is-issue"><span>有問題：' + esc(r.paperNote) + "（已通知上傳人）</span><span class=\"fo-docstate-btns\">" +
        '<button type="button" class="fo-linkbtn" data-act="paperOk" data-id="' + id + '" data-fk="ok:' + id + '"' + dis + ">補件後相符</button>" +
        '<button type="button" class="fo-linkbtn" data-act="paperUndo" data-id="' + id + '" data-fk="undo:' + id + '"' + dis + ">復原</button></span></div>";
    }
    if (C.err[r.id]) h += '<p class="fo-alert" role="alert">' + esc(C.err[r.id]) + "</p>";
    return h + "</div></article>";
  }

  function paintCompleteness(opts) {
    const C = S.comp;
    const recs = C.records || [];
    const counts = { todo: 0, issue: 0, done: 0 };
    recs.forEach((r) => { counts[compState(r)]++; });
    const F = [["todo", "待核對"], ["issue", "有問題"], ["done", "已核對"]];
    let h = '<section class="fo-card"><h1 class="fo-h1">單據完備</h1>' +
      '<p class="fo-lead">主管核准後的單據，請比對紙本和電子檔。相符就按「紙本相符」，總表的「單據完備」會自動打勾；有問題就寫下原因，系統會通知上傳人補件。</p>' +
      '<div class="fo-filters" role="group" aria-label="篩選">' + F.map((f) => '<button type="button" class="fo-filter' + (C.filter === f[0] ? " is-on" : "") + '" aria-pressed="' + (C.filter === f[0]) +
        '" data-act="compFilter" data-filter="' + f[0] + '" data-fk="filter:' + f[0] + '">' + f[1] + "（" + counts[f[0]] + "）</button>").join("") + "</div></section>";
    const shown = recs.filter((r) => compState(r) === C.filter || C.pinned[r.id]);
    if (!shown.length) h += '<section class="fo-card fo-empty"><p>這一類目前沒有單據。</p></section>';
    h += shown.map(compCard).join("");
    paint(h, opts);
  }

  async function actMarkPaper(id, result) {
    const C = S.comp;
    const r = (C.records || []).find((x) => x.id === id);
    if (!r || C.busy[id]) return;
    const note = result === "issue" ? String(C.notes[id] || "").trim() : "";
    if (result === "issue" && !note) {
      C.err[id] = "請寫下哪裡有問題，上傳人才知道要補什麼。";
      repaint({ focus: "note:" + id });
      return;
    }
    const token = S.token;
    C.busy[id] = true;
    C.err[id] = "";
    repaint();
    try {
      const res = await api("financeMarkPaper", { recordId: id, result, note });
      const local = result === "ok" ? { complete: true, paperNote: "" } : result === "issue" ? { complete: false, paperNote: note } : { complete: false, paperNote: "" };
      Object.assign(r, local, res.record && typeof res.record === "object" ? res.record : {});
      r.id = String(r.id);
      C.busy[id] = false;
      C.open[id] = false;
      C.pinned[id] = true;
      if (result === "issue") delete C.notes[id];
      announce({ ok: "已標成紙本相符", issue: "已送出，會通知上傳人補件", undo: "已復原成待核對" }[result]);
      if (token === S.token) repaint({ focus: result === "undo" ? "ok:" + id : "undo:" + id });
    } catch (e) {
      C.busy[id] = false;
      C.err[id] = e.message;
      if (token === S.token) repaint({ focus: S.lastFk });
    }
  }

  /* ============================================================
     事件（全部掛在 #opsRoot 上）
     ============================================================ */
  function fire(p) { if (p && typeof p.catch === "function") p.catch(reportError); }
  function reportError(e) {
    try { console.error("[財務作業]", e); } catch (x) { /* ignore */ }
    S.busy = "";
    S.err = { where: "other", text: (e && e.message) || "發生錯誤，請再試一次。" };
    toast("發生錯誤：" + S.err.text);
    try { repaint(); } catch (x) { /* ignore */ }
  }

  function onClick(e) {
    try {
      // 連到「目前這一頁」的連結（例如已經在待放行，又按一次「待放行」）：網址沒變不會觸發換頁，這裡改成重新整理這一頁
      const link = e.target && e.target.closest ? e.target.closest('a[href^="#finance/ops/"]') : null;
      if (link && link.getAttribute("href") === location.hash && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        go(link.getAttribute("href").replace(/^#finance\/ops\//, ""));
        return;
      }
      const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (!el) return;
      const tag = el.tagName;
      if (tag !== "BUTTON" && tag !== "A") return; // 勾選框、輸入框在 change／input 處理
      if (el.disabled || el.getAttribute("aria-disabled") === "true") { e.preventDefault(); return; }
      S.lastFk = el.getAttribute("data-fk") || null;
      const act = el.getAttribute("data-act");
      const id = el.getAttribute("data-id") || "";
      switch (act) {
        case "retry": { const fn = S.retry; S.retry = null; if (fn) fn(); break; }
        case "startOther": {
          const v = S.otherDate;
          if (!DATE_RE.test(v)) { S.err = { where: "otherDate", text: "請先選一個付款日。" }; repaint({ focus: "otherDate" }); break; }
          go("pay/" + v);
          break;
        }
        case "toSend": {
          const d = S.drafts[S.route.date];
          if (d && isAccountant() && selectedRecords(d).length) go("pay/" + S.route.date + "/send");
          break;
        }
        case "dlBank": fire(actDownloadBank()); break;
        case "send": fire(actSend()); break;
        case "refreshBatch": fire(actRefreshBatch()); break;
        case "withdrawAsk": uiOf(S.route.id).withdrawAsk = true; S.err = null; repaint({ focus: "act:withdrawCancel" }); break;
        case "withdrawCancel": uiOf(S.route.id).withdrawAsk = false; repaint({ focus: "act:withdrawAsk" }); break;
        case "withdraw": fire(actWithdraw()); break;
        case "confirmPaid": fire(actConfirmPaid()); break;
        case "dlImport": fire(actDownloadImport(+el.getAttribute("data-part") || 0)); break;
        case "dlZip": fire(actDownloadZip()); break;
        case "complete": fire(actComplete()); break;
        case "relOn": if (S.rel && has(S.rel.held, id)) { delete S.rel.held[id]; repaint(); } break;
        case "relOff": if (S.rel && !has(S.rel.held, id)) { S.rel.held[id] = ""; repaint(); } break;
        case "relChip": if (S.rel) { const c = HOLD_CHIPS[+el.getAttribute("data-chip")]; if (c) { S.rel.held[id] = c.text; repaint(); } } break;
        case "returnOpen": if (S.rel) { S.rel.returnOpen = !S.rel.returnOpen; S.err = null; repaint(S.rel.returnOpen ? { focus: "returnReason" } : undefined); } break;
        case "returnCancel": if (S.rel) { S.rel.returnOpen = false; repaint({ focus: "act:returnOpen" }); } break;
        case "release": fire(actReleaseOrReturn("release")); break;
        case "doReturn": fire(actReleaseOrReturn("return")); break;
        case "compFilter": S.comp.filter = el.getAttribute("data-filter") || "todo"; S.comp.pinned = {}; repaint(); break;
        case "paperOk": fire(actMarkPaper(id, "ok")); break;
        case "paperIssue": S.comp.open[id] = true; S.comp.err[id] = ""; repaint({ focus: "note:" + id }); break;
        case "paperCancel": S.comp.open[id] = false; S.comp.err[id] = ""; repaint({ focus: "issue:" + id }); break;
        case "paperSave": fire(actMarkPaper(id, "issue")); break;
        case "paperUndo": fire(actMarkPaper(id, "undo")); break;
        default: break;
      }
    } catch (err) {
      reportError(err);
    }
  }

  function onChange(e) {
    try {
      const el = e.target;
      const act = el && el.getAttribute ? el.getAttribute("data-act") : "";
      if (!act) return;
      if (act === "pick") {
        const d = S.drafts[S.route.date];
        if (!d) return;
        d.selected[el.getAttribute("data-id")] = el.checked;
        d.bankChecked = false; // 清單改了，兆豐的檔要重建
        d.bankFile = "";
        const row = el.closest("[data-row]");
        if (row) row.classList.toggle("is-off", !el.checked);
        patchPay(S.route.date);
      } else if (act === "bankChecked") {
        const d = S.drafts[S.route.date];
        if (d) { d.bankChecked = el.checked; repaint(); }
      } else if (act === "paidDate") {
        onPaidDate(el);
      } else if (act === "otherDate") {
        S.otherDate = el.value;
      } else if (act === "chkImport" || act === "chkFiles") {
        uiOf(S.route.id)[act] = el.checked;
        repaint();
      } else if (act === "relConfirm") {
        if (S.rel) { S.rel.confirmed = el.checked; repaint(); }
      }
    } catch (err) {
      reportError(err);
    }
  }

  function onPaidDate(el) {
    const id = S.route.id;
    const entry = S.batches[id];
    if (!entry) return;
    const ui = uiOf(id);
    ui.paidDate = el.value;
    const box = document.getElementById("foMsgs4");
    if (box) box.innerHTML = msgs4Html(entry.batch, paidRecords(entry.batch, entry.records), ui.paidDate);
    const btn = document.getElementById("foConfirmPaid");
    if (btn) btn.disabled = !(isAccountant() && DATE_RE.test(ui.paidDate) && !S.busy);
    const hint = document.getElementById("foPaidDateHint");
    if (hint) hint.hidden = DATE_RE.test(ui.paidDate);
  }

  function onInput(e) {
    try {
      const el = e.target;
      const act = el && el.getAttribute ? el.getAttribute("data-act") : "";
      if (!act) return;
      if (act === "salary") {
        const d = S.drafts[S.route.date];
        if (!d) return;
        const clean = String(el.value || "").replace(/[^0-9]/g, "");
        if (clean !== el.value) el.value = clean;
        d.salary = clean;
        d.bankChecked = false;
        patchPay(S.route.date);
      } else if (act === "relReason") {
        if (!S.rel) return;
        const id = el.getAttribute("data-id");
        S.rel.held[id] = el.value;
        const row = el.closest(".fo-reason");
        if (row) row.querySelectorAll(".fo-rchip").forEach((b) => {
          const on = HOLD_CHIPS[+b.getAttribute("data-chip")].text === el.value;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-pressed", String(on));
        });
        patchRelease(S.rel.batchId);
      } else if (act === "returnReason") {
        if (!S.rel) return;
        S.rel.returnReason = el.value;
        patchRelease(S.rel.batchId);
      } else if (act === "paperNote") {
        S.comp.notes[el.getAttribute("data-id")] = el.value;
      } else if (act === "paidDate") {
        onPaidDate(el);
      } else if (act === "otherDate") {
        S.otherDate = el.value;
      }
    } catch (err) {
      reportError(err);
    }
  }

  function onToggle(e) {
    if (e.target && e.target.id === "foRecent") S.recentOpen = e.target.open;
  }

  window.FinanceOps = { show };
})();
