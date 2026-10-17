/* ============================================================
   團隊後台：首頁（和小U聊天）／認識組織／計畫與預算
   ------------------------------------------------------------
   app.js 每次切到這三頁（登入後、每次網址 # 改變）都會呼叫對應的函式：
     Portal.showHome()   → 畫在 #homeRoot（和新手導師小U聊天）
     Portal.showAbout()  → 畫在 #aboutRoot（小U 從兩本手冊整理的重點、手冊、組織架構、團隊成員）
     Portal.showBudget() → 畫在 #budgetRoot（只開放給主管和財務）
     Portal.reset()      → 登出時呼叫：清掉這個分頁裡存的對話和快取，畫面也清空
   每個 show 函式都可以重複呼叫：第一次畫整頁，之後只更新該更新的地方（對話不會被清掉）。
   這裡不會往外丟錯誤，出錯一律顯示在頁面裡。
   後端動作：askHandbook／getAbout／getAboutOverview／getBudgetOverview。
   用到 app.js 的全域：cloudPost、currentUser、escapeHtml、fmtMoney、showToast、
   hasFinanceRole、canViewBudget、isSignedIn。樣式在 portal.css（class 一律 pt- 開頭）。
   小U 的圖：repo 根目錄的 xiaou.svg（半身）、xiaou-avatar.svg（圓形頭像）；載入失敗會換成圓形佔位。
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- 共用小工具 ---------------- */
  function esc(s) {
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function str(x) { return x === null || x === undefined ? "" : String(x); }
  function num(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
  function arr(x) { return Array.isArray(x) ? x : []; }
  // 只放行 http(s) 連結，避免試算表裡填了 javascript: 之類的東西被當成連結或 iframe 來源
  function safeUrl(u) { const s = str(u).trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : ""; }
  function q(el, role) { return el ? el.querySelector('[data-role="' + role + '"]') : null; }

  function me() {
    try { return typeof currentUser !== "undefined" && currentUser ? currentUser : null; } catch (e) { return null; }
  }
  function userHasFinanceRole() {
    try { if (typeof hasFinanceRole === "function") return !!hasFinanceRole(); } catch (e) { /* 改用下面的判斷 */ }
    const u = me();
    return !!(u && Array.isArray(u.financeRoles) && u.financeRoles.length);
  }
  function userCanViewBudget() {
    try { if (typeof canViewBudget === "function") return !!canViewBudget(); } catch (e) { /* 改用下面的判斷 */ }
    const u = me();
    return !!(u && u.canViewBudget);
  }
  function toast(msg) { try { if (typeof showToast === "function") showToast(msg); } catch (e) { /* 提示失敗不影響功能 */ } }

  function money(n) {
    if (typeof fmtMoney === "function") return fmtMoney(num(n));
    return "NT$ " + num(n).toLocaleString("zh-TW");
  }
  function plain(n) { return num(n).toLocaleString("zh-TW"); }               // 表格裡不帶 NT$
  function signedPlain(n) { return n < 0 ? "−" + plain(-n) : plain(n); }
  function moneyHtml(n) {                                                      // 大數字：NT$ 縮小一點
    const v = num(n);
    return (v < 0 ? "−" : "") + '<span class="pt-cur">NT$</span> ' + Math.abs(v).toLocaleString("zh-TW");
  }

  function ssGet(key) {
    try { const raw = window.sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function ssSet(key, val) {
    try { window.sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 存不了就算了，只是重新整理後要重抓 */ }
  }
  function ssDel(key) {
    try { window.sessionStorage.removeItem(key); } catch (e) { /* 同上 */ }
  }

  // 呼叫後端：一律回傳 { ok:true, ... } 或 { ok:false, error:'給人看的訊息' }，不會丟錯。
  // 另外加一個逾時，避免後端一直沒回應時畫面永遠卡在「讀取中」。
  async function call(action, extra, timeoutMs) {
    if (typeof cloudPost !== "function") return { ok: false, error: "系統還沒準備好，請重新整理頁面。" };
    let timer = null;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: "等太久沒有回應，請再試一次。" }), timeoutMs || 60000);
      });
      const data = await Promise.race([Promise.resolve().then(() => cloudPost(action, extra || {})), timeout]);
      if (!data || typeof data !== "object") return { ok: false, error: "伺服器的回應看不懂，請再試一次。" };
      if (data.ok !== true) return { ok: false, error: str(data.error) || "發生錯誤，請再試一次。" };
      return data;
    } catch (e) {
      return { ok: false, error: "連線失敗，請確認網路後再試一次。" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const CHEVRON = '<svg class="pt-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DOTS = '<span class="pt-dots" aria-hidden="true"><i></i><i></i><i></i></span>';

  function loadingHtml(text) {
    return '<div class="pt-loading" role="status"><span class="pt-spinner" aria-hidden="true"></span>' + esc(text) + "</div>";
  }
  function errorCardHtml(msg) {
    return '<div class="card pt-card pt-errorcard" role="alert">' +
      '<p class="pt-errorcard-text">讀不到資料：' + esc(msg) + "</p>" +
      '<button type="button" class="pt-btn pt-btn-ghost" data-act="retry">重試</button></div>';
  }
  function renderCrash(root, err) {
    try { console.error("[portal]", err); } catch (e) { /* ignore */ }
    try {
      if (root) root.innerHTML = '<div class="card pt-card pt-errorcard" role="alert"><p class="pt-errorcard-text">這一頁出了點問題，請重新整理頁面再試一次。</p></div>';
    } catch (e) { /* ignore */ }
  }

  // 把 node 捲進畫面。obstruct = 底下固定住的輸入框，要讓出它的高度（瀏覽器內建的 scrollIntoView
  // 不知道它擋住了東西）；內容比畫面高時優先露出開頭，讓人從第一行讀起。
  function reveal(node, obstruct) {
    try {
      if (!node || !node.isConnected) return;
      const r = node.getBoundingClientRect();
      if (!r.height) return; // 這一頁現在沒顯示
      const vh = window.innerHeight || document.documentElement.clientHeight;
      let bottom = vh - 12;
      if (obstruct) {
        const o = obstruct.getBoundingClientRect();
        if (o.height && o.top > 0 && o.top < vh) bottom = Math.min(bottom, o.top - 12);
      }
      const top = 12;
      let dy = 0;
      if (r.bottom > bottom) dy = r.bottom - bottom;
      if (r.top - dy < top) dy = r.top - top;
      if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
    } catch (e) { /* 捲不動就算了 */ }
  }

  /* ---------------- 小U 的圖 ---------------- */
  // 圖檔載入失敗就換成圓形佔位（不出現破圖）；之後新畫的頭像直接用佔位，不再重抓壞掉的檔案
  const AVATAR_SRC = "xiaou-avatar.svg";
  const ART_SRC = "xiaou.svg";
  const brokenImg = { avatar: false, art: false };
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.dataset || !img.dataset.ptImg) return;
    brokenImg[img.dataset.ptImg] = true;
    const box = img.closest(".pt-av, .pt-art");
    if (box) box.classList.add("is-fallback");
  }, true);
  function avatarHtml(size) {
    const cls = "pt-av" + (size ? " pt-av-" + size : "") + (brokenImg.avatar ? " is-fallback" : "");
    return '<span class="' + cls + '" aria-hidden="true">' +
      (brokenImg.avatar ? "" : '<img data-pt-img="avatar" src="' + AVATAR_SRC + '" alt="" width="36" height="36">') + "</span>";
  }
  function artHtml() {
    return '<div class="pt-art' + (brokenImg.art ? " is-fallback" : "") + '">' +
      (brokenImg.art ? "" : '<img data-pt-img="art" src="' + ART_SRC + '" alt="小U" width="320" height="360">') + "</div>";
  }
  // 小U 說的一則話：頭像＋名字＋泡泡（after = 泡泡底下的小字）
  function botMsgHtml(bubbleHtml, after) {
    return avatarHtml() + '<div class="pt-msg-body"><p class="pt-msg-name">小U</p>' + bubbleHtml + (after || "") + "</div>";
  }

  /* ---------------- 狀態（換人登入就整個重來） ---------------- */
  const S = { email: null, home: null, about: null, budget: null };
  function freshState() {
    S.home = { el: null, messages: [], waiting: false, gen: 0, composing: false, actionsSig: "" };
    S.about = { el: null, data: null, renderedData: null, loading: false, error: "", openIdx: -1, ov: null, ovLoading: false, ovError: "" };
    S.budget = { el: null, data: null, renderedData: null, fetchedAt: 0, loading: false, error: "", center: "", expanded: new Set() };
  }
  freshState();

  function syncUser() {
    const u = me();
    const email = u && u.email ? String(u.email) : "";
    if (email === S.email) return;
    const switching = S.email !== null;
    S.email = email;
    freshState();
    if (switching) clearRoots(); // 換人登入：上一個人的畫面（例如預算）不要留在頁面裡
    S.home.messages = loadChat();
    const cachedAbout = ssGet(aboutKey());
    if (cachedAbout && typeof cachedAbout === "object") S.about.data = normAbout(cachedAbout);
    const cachedOv = ssGet(overviewKey());
    if (cachedOv && typeof cachedOv === "object" && cachedOv.status === "ready") S.about.ov = normOverview(cachedOv);
  }
  function clearRoots() {
    ["homeRoot", "aboutRoot", "budgetRoot"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
  }
  function reset() {
    try {
      if (S.email !== null) { ssDel(chatKey()); ssDel(aboutKey()); ssDel(overviewKey()); }
      S.email = null;
      freshState();
      clearRoots();
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
     首頁：和小U聊天
     ============================================================ */
  const CHAT_MAX = 20;          // 對話最多留 20 則（小U 的開場白不算）
  const HISTORY_MAX = 6;        // 每次問的時候帶最近 6 則給後端
  const FAQ = ["代墊款怎麼報帳？", "上傳單據後多久會撥款？", "請假要怎麼申請？", "我們的核心價值是什麼？", "新人第一週要做什麼？", "系統用不順可以找誰？"];
  const TYPING_TEXT = "小U 正在查資料，大約 10 秒…";
  const SLOW_TEXT = "比平常久一點，再等我一下…";
  const GENERAL_NOTE = "一般建議，不是組織規定";
  const NONE_LABEL = "這題我找不到答案";
  const NOT_CONFIGURED_NOTE = "我還沒拿到手冊，組織規定的問題暫時答不了，請管理員在總表「知識庫設定」填好手冊連結。";
  let msgSeq = 0;
  function newId() { msgSeq += 1; return "m" + msgSeq + "x" + Date.now().toString(36); }
  function chatKey() { return "pt.chat.v1." + (S.email || "anon"); }

  // 回答的種類：handbook（手冊或系統說明）、general（一般知識）、none（答不出來）。
  // 舊版後端沒有 kind：找得到算 handbook，找不到算 none。
  function answerKind(res) {
    const k = str(res && res.kind).trim();
    if (k === "handbook" || k === "general" || k === "none") return k;
    return res && res.found === false ? "none" : "handbook";
  }

  function normSources(list) {
    const seen = new Set();
    const out = [];
    arr(list).forEach((s) => {
      if (!s) return;
      const title = str(typeof s === "string" ? s : s.title).trim();
      const location = typeof s === "string" ? "" : str(s.location).trim();
      if (!title && !location) return;
      const k = title + "\n" + location;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ title, location });
    });
    return out;
  }
  function sourcesText(sources) {
    return sources.map((s) => [s.title, s.location].filter(Boolean).join("・")).join("、");
  }

  function loadChat() {
    const raw = ssGet(chatKey());
    if (!Array.isArray(raw)) return [];
    const list = raw
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text)
      .slice(-CHAT_MAX)
      .map((m) => {
        const o = { id: newId(), role: m.role, text: m.text };
        if (m.role === "assistant") {
          o.sources = normSources(m.sources);
          o.kind = answerKind(m);
          if (m.notConfigured) o.notConfigured = true;
        } else if (typeof m.error === "string" && m.error) {
          o.error = m.error;
        }
        return o;
      });
    // 上次還在等回答就重新整理了：補一個錯誤，讓人可以按重試
    list.forEach((m, i) => {
      if (m.role === "user" && !m.error && (!list[i + 1] || list[i + 1].role !== "assistant")) m.error = "上次沒有等到回答。";
    });
    return list;
  }
  function saveChat() {
    const H = S.home;
    if (!H.messages.length) { ssDel(chatKey()); return; }
    ssSet(chatKey(), H.messages.map((m) => {
      const o = { role: m.role, text: m.text };
      if (m.sources && m.sources.length) o.sources = m.sources;
      if (m.kind) o.kind = m.kind;
      if (m.notConfigured) o.notConfigured = true;
      if (m.error) o.error = m.error;
      return o;
    }));
  }

  // 回答排版：先整段跳脫，再把 **粗體**、「• 」或「- 」開頭的行（條列）、換行轉成 HTML
  function inlineFmt(s) { return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }
  function formatAnswer(text) {
    const lines = esc(str(text).replace(/\r\n?/g, "\n")).split("\n");
    const out = [];
    let para = [];
    let list = [];
    const flushPara = () => { if (para.length) { out.push("<p>" + para.map(inlineFmt).join("<br>") + "</p>"); para = []; } };
    const flushList = () => { if (list.length) { out.push("<ul>" + list.map((li) => "<li>" + inlineFmt(li) + "</li>").join("") + "</ul>"); list = []; } };
    lines.forEach((line) => {
      const m = /^\s*(?:•|-)\s+(.*)$/.exec(line);
      if (m) { flushPara(); list.push(m[1]); }
      else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line.trim()); }
    });
    flushPara();
    flushList();
    return out.join("");
  }

  function greetingText() {
    const u = me();
    const name = u && u.name ? str(u.name).trim() : "";
    return (name ? "嗨，" + name + "！" : "嗨！") +
      "我是 Skills for U 的新手導師，你可以稱呼我：小U。組織的規定、流程、文化，或是工作上卡住的地方，都可以問我。";
  }
  function actionsSig() { return (userHasFinanceRole() ? "f" : "") + (userCanViewBudget() ? "b" : ""); }
  function actionLinksHtml() {
    const links = [
      { href: "#finance/upload", label: "上傳單據" },
      { href: "#finance/mine", label: "上傳紀錄" },
    ];
    if (userHasFinanceRole()) links.push({ href: "#finance/ops", label: "財務作業" });
    if (userCanViewBudget()) links.push({ href: "#budget", label: "計畫與預算" });
    return links.map((l) => '<a class="pt-action" href="' + l.href + '">' + l.label + "</a>").join("") +
      '<a class="pt-action" href="https://secure.swingvy.com" target="_blank" rel="noopener">人事中心（Swingvy）' +
      '<span class="pt-ext" aria-hidden="true">↗</span><span class="sr-only">（在新分頁開啟）</span></a>';
  }
  function faqChipsHtml() {
    return FAQ.map((s) => '<button type="button" class="pt-chip-btn" data-act="ask" data-q="' + esc(s) + '">' + esc(s) + "</button>").join("");
  }

  function showHome() {
    const root = document.getElementById("homeRoot");
    if (!root) return;
    try {
      syncUser();
      const H = S.home;
      if (!H.el || !root.contains(H.el)) mountHome(root);
      else refreshHomeHeader();
    } catch (e) {
      renderCrash(root, e);
    }
  }

  function mountHome(root) {
    const H = S.home;
    const wrap = document.createElement("div");
    wrap.className = "pt-home";
    wrap.innerHTML =
      // 桌機：左邊的小U介紹卡；手機：縮成聊天上方的一行（頭像＋小U＋新手導師）
      '<aside class="pt-prof" aria-labelledby="ptProfName">' +
        artHtml() +
        '<div class="pt-prof-main">' +
          avatarHtml("lg") +
          '<div class="pt-prof-text">' +
            '<h1 class="pt-prof-name" id="ptProfName">小U</h1>' +
            '<p class="pt-prof-title"><span class="pt-prof-org">Skills for U </span>新手導師</p>' +
          "</div>" +
        "</div>" +
        '<p class="pt-prof-intro">我讀過兩本組織手冊，也熟悉這個後台，有問題隨時問我。</p>' +
        '<p class="pt-prof-note">回答以手冊為準，拿不準的事再問主管。</p>' +
      "</aside>" +
      '<section class="card pt-card pt-chat" aria-label="和小U聊天">' +
        '<div class="pt-thread">' +
          // 小U 的開場白永遠是第一則，不存進對話紀錄、也不送給後端
          '<div class="pt-msg pt-msg-bot pt-greeting">' +
            botMsgHtml('<div class="pt-bubble"><p data-role="greet">' + esc(greetingText()) + "</p>" +
              '<div class="pt-actions" data-role="actions">' + actionLinksHtml() + "</div></div>") +
          "</div>" +
          '<div class="pt-faq" data-role="faq-inline">' +
            '<p class="pt-faq-label" id="ptFaqLabel">常見問題</p>' +
            '<div class="pt-faq-list" role="group" aria-labelledby="ptFaqLabel">' + faqChipsHtml() + "</div>" +
          "</div>" +
          '<div class="pt-log" data-role="log" role="log" aria-live="polite" aria-label="和小U的對話"></div>' +
        "</div>" +
        '<form class="pt-composer" data-role="form" novalidate>' +
          '<div class="pt-faq-panel" id="ptFaqPanel" data-role="faq-panel" role="group" aria-label="常見問題" hidden>' + faqChipsHtml() + "</div>" +
          '<label class="sr-only" for="ptAskInput">問小U</label>' +
          '<div class="pt-composer-row">' +
            '<textarea id="ptAskInput" class="textarea-input pt-input" data-role="input" rows="1" maxlength="1000" placeholder="問小U任何問題…" aria-describedby="ptAskHint"></textarea>' +
            '<button type="submit" class="pt-send" data-role="send">送出</button>' +
          "</div>" +
          '<div class="pt-composer-foot">' +
            '<button type="button" class="pt-faq-toggle" data-act="faq-toggle" aria-expanded="false" aria-controls="ptFaqPanel" hidden>常見問題' + CHEVRON + "</button>" +
            '<p class="pt-composer-hint" id="ptAskHint">按 Enter 送出，Shift + Enter 換行</p>' +
            '<button type="button" class="pt-textbtn" data-act="clear" hidden>清除對話</button>' +
          "</div>" +
        "</form>" +
      "</section>";
    // 先把之前的對話放進去再掛到頁面上，螢幕報讀才不會把舊對話整串念一遍
    const log = q(wrap, "log");
    const firstNc = H.messages.find((m) => m.notConfigured);
    H.messages.forEach((m) => log.appendChild(msgNode(m, m === firstNc)));
    root.innerHTML = "";
    root.appendChild(wrap);
    H.el = wrap;
    H.actionsSig = actionsSig();
    bindHome(H);
    updateChatChrome();
  }

  function refreshHomeHeader() {
    const H = S.home;
    const g = q(H.el, "greet");
    const text = greetingText();
    if (g && g.textContent !== text) g.textContent = text;
    const sig = actionsSig();
    if (sig !== H.actionsSig) {
      const box = q(H.el, "actions");
      if (box) box.innerHTML = actionLinksHtml();
      H.actionsSig = sig;
    }
  }

  function bindHome(H) {
    const el = H.el;
    const input = q(el, "input");
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn || !el.contains(btn)) return;
      const viaKeyboard = e.detail === 0; // 用鍵盤按的才把焦點移回輸入框（手機上不要自動跳出鍵盤）
      const act = btn.dataset.act;
      if (act === "ask") { setFaqPanel(false); sendQuestion(btn.dataset.q || btn.textContent, viaKeyboard); }
      else if (act === "faq-toggle") setFaqPanel(btn.getAttribute("aria-expanded") !== "true");
      else if (act === "clear") clearChat(viaKeyboard);
      else if (act === "retry") retryMessage(btn.dataset.id, viaKeyboard);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || q(el, "faq-panel").hidden) return;
      setFaqPanel(false);
      const t = el.querySelector('[data-act="faq-toggle"]');
      if (t && !t.hidden) t.focus();
    });
    q(el, "form").addEventListener("submit", (e) => { e.preventDefault(); submitInput(); });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      // 注音／倉頡選字時按的 Enter 不能送出（Safari 選字結束那一下 keyCode 是 229）
      if (e.isComposing || e.keyCode === 229 || H.composing) return;
      e.preventDefault();
      submitInput();
    });
    input.addEventListener("compositionstart", () => { H.composing = true; });
    input.addEventListener("compositionend", () => { H.composing = false; });
    input.addEventListener("blur", () => { H.composing = false; });
    input.addEventListener("input", () => autoGrow(input));
  }

  function setFaqPanel(open) {
    const H = S.home;
    if (!H.el) return;
    q(H.el, "faq-panel").hidden = !open;
    const t = H.el.querySelector('[data-act="faq-toggle"]');
    if (t) t.setAttribute("aria-expanded", String(!!open));
  }

  function autoGrow(ta) {
    try {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight + 3, 168) + "px";
    } catch (e) { /* ignore */ }
  }

  function submitInput() {
    const H = S.home;
    if (!H.el || H.waiting) return;
    const input = q(H.el, "input");
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = "";
    autoGrow(input);
    sendQuestion(text, false);
  }

  function sendQuestion(text, refocus) {
    const H = S.home;
    const question = str(text).trim();
    if (!question || H.waiting || !H.el) return;
    const msg = { id: newId(), role: "user", text: question };
    H.messages.push(msg);
    q(H.el, "log").appendChild(msgNode(msg, false));
    askFor(msg);
    if (refocus) q(H.el, "input").focus();
  }

  function retryMessage(id, refocus) {
    const H = S.home;
    if (H.waiting) return;
    const m = H.messages.find((x) => x.id === id);
    if (!m) return;
    askFor(m);
    if (refocus && H.el) q(H.el, "input").focus();
  }

  function clearChat(refocus) {
    const H = S.home;
    H.gen += 1;            // 還在等的回答回來時直接丟掉
    H.waiting = false;
    H.messages = [];
    ssDel(chatKey());
    if (H.el) q(H.el, "log").innerHTML = "";
    updateChatChrome();
    if (refocus && H.el) q(H.el, "input").focus();
  }

  function buildHistory(prev) {
    return prev
      .filter((m) => m.role === "assistant" || !m.error)
      .slice(-HISTORY_MAX)
      .map((m) => ({ role: m.role, text: m.text }));
  }

  function nodeFor(msg) {
    const H = S.home;
    return H.el ? H.el.querySelector('.pt-msg[data-id="' + msg.id + '"]') : null;
  }
  function insertAfter(parent, node, ref) {
    if (ref && ref.parentNode === parent) parent.insertBefore(node, ref.nextSibling);
    else parent.appendChild(node);
  }
  function revealInChat(node) { reveal(node, S.home.el && S.home.el.querySelector(".pt-composer")); }

  function trimChat() {
    const H = S.home;
    while (H.messages.length > CHAT_MAX) {
      const old = H.messages.shift();
      const n = nodeFor(old);
      if (n) n.remove();
    }
  }

  async function askFor(userMsg) {
    const H = S.home;
    if (H.waiting || !H.el) return;
    H.waiting = true;
    const gen = H.gen;
    delete userMsg.error;
    const log = q(H.el, "log");
    const userNode = nodeFor(userMsg);
    const oldErr = userNode && userNode.querySelector(".pt-msg-error");
    if (oldErr) oldErr.remove();
    const typing = typingNode();
    insertAfter(log, typing, userNode);
    trimChat();
    saveChat();
    updateChatChrome();
    revealInChat(typing);

    const idx = H.messages.indexOf(userMsg);
    const history = buildHistory(H.messages.slice(0, idx < 0 ? H.messages.length : idx));
    const slowTimer = setTimeout(() => {
      const t = typing.querySelector('[data-role="ptext"]');
      if (t) t.textContent = SLOW_TEXT;
    }, 20000);
    const res = await call("askHandbook", { question: userMsg.text, history }, 90000);
    clearTimeout(slowTimer);
    if (H !== S.home || gen !== H.gen) return; // 對話已清除或換人登入：丟掉這個回答

    H.waiting = false;
    typing.remove();
    if (res.ok) {
      const ans = { id: newId(), role: "assistant", text: str(res.answer).trim() || "我這次沒有想出答案，可以換個問法再問我一次嗎？", sources: normSources(res.sources), kind: answerKind(res) };
      if (res.notConfigured) ans.notConfigured = true;
      const i = H.messages.indexOf(userMsg);
      if (i >= 0) H.messages.splice(i + 1, 0, ans);
      else H.messages.push(ans);
      const node = msgNode(ans, H.messages.find((m) => m.notConfigured) === ans);
      insertAfter(log, node, nodeFor(userMsg));
      trimChat();
      saveChat();
      updateChatChrome();
      revealInChat(node);
    } else {
      userMsg.error = res.error || "沒有收到回答。";
      const un = nodeFor(userMsg);
      if (un) un.querySelector(".pt-msg-body").appendChild(errorRow(userMsg));
      saveChat();
      updateChatChrome();
      revealInChat(un);
    }
  }

  function updateChatChrome() {
    const H = S.home;
    if (!H.el) return;
    const empty = H.messages.length === 0;
    // 還沒開始聊：常見問題直接列在開場白底下；聊開之後收進輸入框旁的「常見問題」按鈕
    q(H.el, "faq-inline").hidden = !empty;
    const toggle = H.el.querySelector('[data-act="faq-toggle"]');
    if (toggle) toggle.hidden = empty;
    if (empty) setFaqPanel(false);
    const clearBtn = H.el.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.hidden = empty;
    q(H.el, "send").disabled = H.waiting;
    H.el.querySelectorAll('[data-act="retry"], [data-act="ask"]').forEach((b) => { b.disabled = H.waiting; });
    q(H.el, "log").classList.toggle("is-empty", empty);
  }

  // showNcNote：知識庫還沒設定的提醒只掛在第一則這種回答底下，不要每則都重複
  function msgNode(m, showNcNote) {
    const n = document.createElement("div");
    n.dataset.id = m.id;
    if (m.role === "user") {
      n.className = "pt-msg pt-msg-user";
      n.innerHTML = '<div class="pt-msg-body"><div class="pt-bubble"><span class="sr-only">你問：</span>' + esc(m.text) + "</div></div>";
      if (m.error) n.firstChild.appendChild(errorRow(m));
      return n;
    }
    const kind = m.kind || "handbook";
    n.className = "pt-msg pt-msg-bot" + (kind === "none" ? " pt-msg-hint" : "");
    let after = "";
    if (m.sources && m.sources.length) after += '<p class="pt-sources">出處：' + esc(sourcesText(m.sources)) + "</p>";
    if (kind === "general") after += '<p class="pt-note pt-note-general">' + GENERAL_NOTE + "</p>";
    if (m.notConfigured && showNcNote) after += '<p class="pt-note pt-note-nc">' + NOT_CONFIGURED_NOTE + "</p>";
    n.innerHTML = botMsgHtml('<div class="pt-bubble">' +
      (kind === "none" ? '<p class="pt-hint-label">' + NONE_LABEL + "</p>" : "") +
      '<div class="pt-answer">' + formatAnswer(m.text) + "</div></div>", after);
    return n;
  }
  function errorRow(m) {
    const r = document.createElement("div");
    r.className = "pt-msg-error";
    r.innerHTML = '<p class="pt-msg-error-text">沒有收到回答：' + esc(m.error) + "</p>" +
      '<button type="button" class="pt-btn pt-btn-ghost pt-btn-sm" data-act="retry" data-id="' + esc(m.id) + '">重試</button>';
    return r;
  }
  function typingNode() {
    const n = document.createElement("div");
    n.className = "pt-msg pt-msg-bot pt-msg-pending";
    n.innerHTML = botMsgHtml('<div class="pt-bubble pt-typing">' + DOTS + "</div>",
      '<p class="pt-typing-note" data-role="ptext">' + TYPING_TEXT + "</p>");
    return n;
  }

  /* ============================================================
     認識組織：小U 從兩本手冊整理的重點（getAboutOverview，慢）
              ＋手冊、組織架構、團隊成員（getAbout，快）
     兩個分開抓，快的先畫出來；重點第一次要 20～40 秒。
     ============================================================ */
  const OV_LOADING_TEXT = "小U 正在讀手冊、整理重點，第一次大約要半分鐘…";
  function aboutKey() { return "pt.about.v1." + (S.email || "anon"); }
  function overviewKey() { return "pt.overview.v1." + (S.email || "anon"); }

  function normAbout(res) {
    return {
      handbooks: arr(res.handbooks).filter((h) => h && typeof h === "object").map((h) => ({
        title: str(h.title).trim() || "（未命名手冊）",
        description: str(h.description).trim(),
        openUrl: safeUrl(h.openUrl),
        previewUrl: safeUrl(h.previewUrl),
      })),
      centers: arr(res.centers).filter((c) => c && typeof c === "object").map((c) => ({
        name: str(c.name).trim() || "（未命名中心）",
        approvers: arr(c.approvers).map((x) => str(x).trim()).filter(Boolean),
        projects: arr(c.projects).map((x) => str(x).trim()).filter(Boolean),
      })),
      people: arr(res.people).filter((p) => p && typeof p === "object").map((p) => ({
        name: str(p.name).trim(),
        email: str(p.email).trim(),
        financeRoles: arr(p.financeRoles).map((x) => str(x).trim()).filter(Boolean),
        approverOf: arr(p.approverOf).map((x) => str(x).trim()).filter(Boolean),
      })),
    };
  }
  function normOverview(o) {
    o = o && typeof o === "object" ? o : {};
    const intro = o.intro && typeof o.intro === "object" ? o.intro : {};
    return {
      status: ["ready", "notConfigured", "unavailable"].includes(o.status) ? o.status : "unavailable",
      message: str(o.message).trim(),
      updatedAt: str(o.updatedAt).trim(),
      intro: { name: str(intro.name).trim(), tagline: str(intro.tagline).trim(), summary: str(intro.summary).trim() },
      sections: arr(o.sections).filter((s) => s && typeof s === "object").map((s) => ({
        title: str(s.title).trim(),
        handbook: str(s.handbook).trim(),
        points: arr(s.points).filter((p) => p && typeof p === "object")
          .map((p) => ({ title: str(p.title).trim(), text: str(p.text).trim(), location: str(p.location).trim() }))
          .filter((p) => p.title || p.text),
      })).filter((s) => s.title || s.points.length),
    };
  }

  function showAbout() {
    const root = document.getElementById("aboutRoot");
    if (!root) return;
    try {
      syncUser();
      const A = S.about;
      if (!A.el || !root.contains(A.el)) mountAbout(root);
      if (!A.data && !A.loading) loadAbout();
      // 重點整理好了就整個工作階段沿用；還沒設定／暫時不能用的狀態，下次進來再問一次
      if ((!A.ov || A.ov.status !== "ready") && !A.ovLoading) loadOverview();
    } catch (e) {
      renderCrash(root, e);
    }
  }

  function mountAbout(root) {
    const A = S.about;
    root.innerHTML =
      '<div class="pt-page pt-about">' +
        '<div class="pt-page-head">' +
          '<div><h1 class="pt-h1">認識組織</h1><p class="pt-sub">組織介紹、手冊重點、組織架構和團隊成員。</p></div>' +
          '<button type="button" class="pt-btn pt-btn-ghost" data-act="refresh">重新整理</button>' +
        "</div>" +
        '<div class="pt-ov" data-role="overview"></div>' +
        '<div data-role="alert"></div>' +
        '<div data-role="body"></div>' +
      "</div>";
    A.el = root.firstElementChild;
    A.renderedData = null;
    A.el.addEventListener("click", onAboutClick);
    renderOverview();
    renderAbout();
  }

  function renderAboutButton() {
    const A = S.about;
    const btn = A.el && A.el.querySelector('[data-act="refresh"]');
    if (!btn) return;
    const busy = A.loading || A.ovLoading;
    btn.disabled = busy;
    btn.textContent = busy ? "讀取中…" : "重新整理";
  }

  // 下半部（手冊、組織架構、團隊成員）
  function renderAbout() {
    const A = S.about;
    if (!A.el) return;
    renderAboutButton();
    q(A.el, "alert").innerHTML = A.error && A.data ? '<div class="pt-alert pt-alert-error" role="alert">重新整理失敗：' + esc(A.error) + "</div>" : "";
    const body = q(A.el, "body");
    body.setAttribute("aria-busy", A.loading ? "true" : "false");
    body.classList.toggle("pt-stale", !!(A.loading && A.data));
    if (A.data) {
      if (A.renderedData !== A.data) {
        body.innerHTML = handbooksHtml(A.data.handbooks) + centersHtml(A.data.centers) + peopleHtml(A.data.people);
        A.renderedData = A.data;
        if (A.openIdx >= 0) openHandbook(A.openIdx, false); // 重新整理前開著的手冊繼續開著
      }
    } else {
      A.renderedData = null;
      body.innerHTML = A.loading ? loadingHtml("正在讀取組織資料…") : A.error ? errorCardHtml(A.error) : "";
    }
  }

  // 上半部（小U 整理的重點）
  function renderOverview() {
    const A = S.about;
    if (!A.el) return;
    renderAboutButton();
    const box = q(A.el, "overview");
    box.setAttribute("aria-busy", A.ovLoading ? "true" : "false");
    box.classList.toggle("pt-stale", !!(A.ovLoading && A.ov));
    if (A.ovLoading && A.ov) return; // 重新整理中：舊內容先留著（變淡），回來再換
    let html = "";
    if (A.ov) {
      html = (A.ovError ? '<div class="pt-alert pt-alert-error" role="alert">重點沒有更新成功：' + esc(A.ovError) + "</div>" : "") + overviewHtml(A.ov);
    } else if (A.ovLoading) {
      html = xiaouBlockHtml(OV_LOADING_TEXT, { typing: true });
    } else if (A.ovError) {
      html = xiaouBlockHtml("整理重點的時候出了點問題：" + A.ovError, { retry: true, error: true });
    }
    box.innerHTML = html;
  }

  async function loadAbout() {
    const A = S.about;
    if (A.loading) return;
    A.loading = true;
    A.error = "";
    renderAbout();
    const res = await call("getAbout", {}, 60000);
    if (A !== S.about) return; // 換人登入了
    A.loading = false;
    if (res.ok) {
      A.data = normAbout(res);
      ssSet(aboutKey(), A.data);
    } else {
      A.error = res.error;
    }
    renderAbout();
  }

  async function loadOverview() {
    const A = S.about;
    if (A.ovLoading) return;
    A.ovLoading = true;
    A.ovError = "";
    renderOverview();
    const res = await call("getAboutOverview", {}, 120000); // 第一次要讓 Gemini 讀完兩本手冊，給久一點
    if (A !== S.about) return;
    A.ovLoading = false;
    if (res.ok) {
      A.ov = normOverview(res.overview);
      if (A.ov.status === "ready") ssSet(overviewKey(), A.ov); else ssDel(overviewKey());
    } else {
      A.ovError = res.error;
    }
    renderOverview();
  }

  function onAboutClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "refresh") { loadAbout(); loadOverview(); }
    else if (act === "retry") loadAbout();
    else if (act === "ov-retry") loadOverview();
    else if (act === "toggle-hb") toggleHandbook(Number(b.dataset.idx));
  }

  // 小U 說一句話的區塊（讀取中／沒有設定／出錯）
  function xiaouBlockHtml(text, opts) {
    opts = opts || {};
    const role = opts.error ? ' role="alert"' : opts.typing ? ' role="status"' : "";
    return '<div class="card pt-card pt-xiaou-block' + (opts.error ? " is-error" : "") + '"' + role + ">" +
      '<div class="pt-msg pt-msg-bot">' +
        botMsgHtml('<div class="pt-bubble' + (opts.typing ? " pt-bubble-typing" : "") + '">' + (opts.typing ? DOTS : "") + "<span>" + esc(text) + "</span></div>") +
      "</div>" +
      (opts.retry ? '<button type="button" class="pt-btn pt-btn-ghost pt-xiaou-retry" data-act="ov-retry">重試</button>' : "") +
    "</div>";
  }

  function overviewHtml(ov) {
    if (ov.status === "notConfigured") {
      return xiaouBlockHtml(ov.message || "手冊還沒設定好，我暫時沒辦法整理重點。請管理員在總表「知識庫設定」填好手冊連結。");
    }
    if (ov.status === "unavailable") {
      return xiaouBlockHtml(ov.message || "我現在沒辦法整理重點，等一下再試試看。", { retry: true });
    }
    return heroHtml(ov) + overviewSectionsHtml(ov.sections);
  }

  function heroHtml(ov) {
    const i = ov.intro;
    return '<section class="pt-hero" aria-labelledby="ptHeroName">' +
      '<h2 class="pt-hero-name" id="ptHeroName">' + esc(i.name || "Skills for U") + "</h2>" +
      (i.tagline ? '<p class="pt-hero-tagline">' + esc(i.tagline) + "</p>" : "") +
      (i.summary ? '<div class="pt-hero-summary">' + formatAnswer(i.summary) + "</div>" : "") +
      '<p class="pt-hero-meta">' + avatarHtml("sm") +
        "<span>小U 從兩本手冊整理，內容以手冊為準" +
        (ov.updatedAt ? '<span class="pt-hero-time">・更新於 ' + esc(ov.updatedAt) + "</span>" : "") + "</span></p>" +
    "</section>";
  }

  function overviewSectionsHtml(sections) {
    if (!sections.length) return "";
    return '<section class="pt-section" aria-labelledby="ptOvTitle"><h2 class="pt-h2" id="ptOvTitle">手冊重點</h2>' +
      '<div class="pt-ov-grid">' + sections.map((s) =>
        '<article class="card pt-card pt-ov-card">' +
          '<h3 class="pt-h3">' + esc(s.title || "重點") + "</h3>" +
          (s.handbook ? '<p class="pt-ov-from">出自〈' + esc(s.handbook) + "〉</p>" : "") +
          (s.points.length
            ? '<ul class="pt-points">' + s.points.map((p) =>
                '<li class="pt-point">' +
                  (p.title ? '<strong class="pt-point-title">' + esc(p.title) + "</strong>" : "") +
                  (p.text ? '<div class="pt-point-text">' + formatAnswer(p.text) + "</div>" : "") +
                  (p.location ? '<p class="pt-point-loc">' + esc(p.location) + "</p>" : "") +
                "</li>").join("") + "</ul>"
            : "") +
        "</article>").join("") +
      "</div></section>";
  }

  function handbooksHtml(list) {
    let inner;
    if (!list.length) {
      inner = '<div class="card pt-card"><p class="empty-state pt-empty">手冊還沒設定。請管理員到總表「知識庫設定」分頁填入手冊連結。</p></div>';
    } else {
      inner = '<div class="pt-hb-list">' + list.map((h, i) => {
        const actions = [];
        if (h.openUrl) {
          actions.push('<a class="pt-btn pt-btn-ghost" href="' + esc(h.openUrl) + '" target="_blank" rel="noopener">打開手冊' +
            '<span class="pt-ext" aria-hidden="true">↗</span><span class="sr-only">（在新分頁開啟）</span></a>');
        }
        if (h.previewUrl) {
          actions.push('<button type="button" class="pt-btn pt-btn-primary" data-act="toggle-hb" data-idx="' + i + '" aria-expanded="false" aria-controls="ptHbView' + i + '">在這裡看</button>');
        }
        if (!actions.length) actions.push('<span class="pt-small pt-muted">連結還沒設定</span>');
        return '<article class="card pt-card pt-hb">' +
          '<div class="pt-hb-head">' +
            '<div class="pt-hb-text"><h3 class="pt-h3">' + esc(h.title) + "</h3>" +
              (h.description ? '<p class="pt-desc">' + esc(h.description) + "</p>" : "") + "</div>" +
            '<div class="pt-hb-actions">' + actions.join("") + "</div>" +
          "</div>" +
          (h.previewUrl ? '<div class="pt-hb-view" id="ptHbView' + i + '" hidden></div>' : "") +
        "</article>";
      }).join("") + "</div>";
    }
    const heading = list.length === 2 ? "兩本手冊" : "組織手冊";
    return '<section class="pt-section" aria-labelledby="ptAboutHb"><h2 class="pt-h2" id="ptAboutHb">' + heading + "</h2>" + inner + "</section>";
  }

  // 一次只開一個預覽：收掉其他的（連 iframe 一起拿掉，免得背景還在載入）
  function toggleHandbook(idx) {
    const A = S.about;
    if (!A.el || !A.data) return;
    const next = A.openIdx === idx ? -1 : idx;
    closeAllHandbooks();
    A.openIdx = next;
    if (next >= 0) openHandbook(next, true);
  }
  function closeAllHandbooks() {
    const A = S.about;
    A.el.querySelectorAll(".pt-hb-view").forEach((v) => { v.hidden = true; v.innerHTML = ""; });
    A.el.querySelectorAll('[data-act="toggle-hb"]').forEach((b) => { b.setAttribute("aria-expanded", "false"); b.textContent = "在這裡看"; });
  }
  function openHandbook(idx, scroll) {
    const A = S.about;
    const h = A.data && A.data.handbooks[idx];
    const view = A.el.querySelector("#ptHbView" + idx);
    const btn = A.el.querySelector('[data-act="toggle-hb"][data-idx="' + idx + '"]');
    if (!h || !h.previewUrl || !view || !btn) { A.openIdx = -1; return; }
    view.innerHTML = '<iframe class="pt-hb-frame" src="' + esc(h.previewUrl) + '" title="' + esc(h.title) + '（預覽）" allow="fullscreen"></iframe>' +
      '<p class="pt-hb-note">看不到內容的話，請確認這個瀏覽器已經用組織帳號登入 Google，或改按「打開手冊」。</p>';
    view.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    btn.textContent = "收起";
    if (scroll) reveal(view.closest(".pt-hb"));
  }

  function centersHtml(list) {
    const inner = list.length
      ? '<div class="pt-center-grid">' + list.map((c) =>
          '<article class="card pt-card pt-center">' +
            '<h3 class="pt-h3">' + esc(c.name) + "</h3>" +
            '<p class="pt-kv"><span class="pt-k">主管：</span>' + (c.approvers.length ? c.approvers.map(esc).join("、") : '<span class="pt-muted">還沒設定</span>') + "</p>" +
            '<p class="pt-k pt-k-block">專案</p>' +
            (c.projects.length
              ? '<ul class="pt-tags">' + c.projects.map((p) => '<li class="pt-tag">' + esc(p) + "</li>").join("") + "</ul>"
              : '<p class="pt-small pt-muted">還沒有專案</p>') +
          "</article>").join("") + "</div>"
      : '<div class="card pt-card"><p class="empty-state pt-empty">還沒有組織架構資料。</p></div>';
    return '<section class="pt-section" aria-labelledby="ptAboutOrg"><h2 class="pt-h2" id="ptAboutOrg">組織架構</h2>' + inner + "</section>";
  }

  function personHtml(p) {
    const badges = p.approverOf.map((c) => '<span class="pt-badge pt-badge-lead">' + esc(c) + "主管</span>")
      .concat(p.financeRoles.map((r) => '<span class="pt-badge pt-badge-fin">財務・' + esc(r) + "</span>"));
    const email = /^[^\s@<>"']+@[^\s@<>"']+$/.test(p.email)
      ? '<a class="pt-person-email" href="mailto:' + esc(p.email) + '">' + esc(p.email) + "</a>"
      : '<span class="pt-person-email pt-muted">' + (esc(p.email) || "—") + "</span>";
    return '<li class="pt-person">' +
      '<span class="pt-person-name">' + (esc(p.name) || "（未填姓名）") + "</span>" + email +
      '<span class="pt-roles">' + (badges.length ? '<span class="sr-only">角色：</span>' + badges.join("") : "") + "</span>" +
    "</li>";
  }
  function peopleHtml(list) {
    const inner = list.length
      ? '<div class="card pt-card pt-people-card">' +
          '<div class="pt-people-head" aria-hidden="true"><span>姓名</span><span>Email</span><span>角色</span></div>' +
          '<ul class="pt-people">' + list.map(personHtml).join("") + "</ul>" +
        "</div>"
      : '<div class="card pt-card"><p class="empty-state pt-empty">還沒有成員資料。</p></div>';
    return '<section class="pt-section" aria-labelledby="ptAboutPeople"><h2 class="pt-h2" id="ptAboutPeople">團隊成員' +
      (list.length ? '<span class="pt-h2-count">' + list.length + " 人</span>" : "") + "</h2>" + inner + "</section>";
  }

  /* ============================================================
     計畫與預算（只開放給主管和財務）
     ============================================================ */
  const BUDGET_FRESH_MS = 20000; // 20 秒內切回來直接用剛抓的資料
  const FOOTNOTE = "已用金額來自收支總表：已核准（含已付款）的單據才算已用，被退回的不算。預算金額請在總表「預算項目設定」分頁的「預算金額」欄填寫。";

  function normProject(p) {
    p = p && typeof p === "object" ? p : {};
    const u = p.unassigned && typeof p.unassigned === "object" ? p.unassigned : {};
    return {
      name: str(p.name).trim() || "（未命名專案）",
      status: str(p.status).trim(),
      budget: num(p.budget), approved: num(p.approved), paid: num(p.paid), pending: num(p.pending),
      items: arr(p.items).filter((it) => it && typeof it === "object").map((it) => ({
        category: str(it.category).trim(), item: str(it.item).trim(),
        budget: num(it.budget), approved: num(it.approved), paid: num(it.paid), pending: num(it.pending), count: num(it.count),
      })),
      unassigned: { approved: num(u.approved), paid: num(u.paid), pending: num(u.pending), count: num(u.count) },
    };
  }
  function sumProjects(projects) {
    return projects.reduce((t, p) => ({
      budget: t.budget + p.budget, approved: t.approved + p.approved, paid: t.paid + p.paid, pending: t.pending + p.pending,
    }), { budget: 0, approved: 0, paid: 0, pending: 0 });
  }
  function normBudget(res) {
    const centers = arr(res.centers).filter((c) => c && typeof c === "object").map((c) => ({
      name: str(c.name).trim() || "（未命名中心）",
      projects: arr(c.projects).map(normProject),
    }));
    const t = res.totals && typeof res.totals === "object" ? res.totals : null;
    const totals = t
      ? { budget: num(t.budget), approved: num(t.approved), paid: num(t.paid), pending: num(t.pending) }
      : sumProjects([].concat(...centers.map((c) => c.projects)));
    return { generatedAt: str(res.generatedAt).trim(), totals, centers };
  }

  // 執行率：超過預算＝超支（紅），90% 以上＝接近上限（黃），其他深藍。預算是 0 回傳 null（不顯示比率）。
  function rateInfo(approved, budget) {
    if (!(budget > 0)) return null;
    const pct = Math.max(0, (approved / budget) * 100);
    const level = approved > budget ? "over" : pct >= 90 ? "warn" : "ok";
    let text;
    if (level === "over") text = (pct < 101 ? (Math.ceil(pct * 10) / 10).toFixed(1) : String(Math.round(pct))) + "%";
    else if (pct > 0 && pct < 1) text = "<1%";
    else text = Math.floor(pct) + "%";
    return { pct, level, text, width: Math.min(100, pct) };
  }
  function flagHtml(rate) {
    if (rate.level === "over") return '<span class="pt-flag pt-flag-over">超支</span>';
    if (rate.level === "warn") return '<span class="pt-flag pt-flag-warn">接近上限</span>';
    return "";
  }
  function isEnded(p) { return /結束|結案/.test(p.status); }
  function statusClass(s) { return /結束|結案/.test(s) ? "is-ended" : s === "進行中" ? "is-active" : "is-other"; }

  function showBudget() {
    const root = document.getElementById("budgetRoot");
    if (!root) return;
    try {
      syncUser();
      const B = S.budget;
      if (!userCanViewBudget()) {
        B.el = null;
        root.innerHTML =
          '<div class="pt-page"><div class="card pt-card pt-gate">' +
            '<h1 class="pt-h1">計畫與預算</h1>' +
            '<p class="pt-gate-text">這一頁只開放給主管和財務。</p>' +
            '<a class="pt-btn pt-btn-ghost" href="#home">回首頁</a>' +
          "</div></div>";
        return;
      }
      if (!B.el || !root.contains(B.el)) mountBudget(root);
      const fresh = B.data && Date.now() - B.fetchedAt < BUDGET_FRESH_MS;
      if (!fresh && !B.loading) loadBudget(false);
    } catch (e) {
      renderCrash(root, e);
    }
  }

  function mountBudget(root) {
    const B = S.budget;
    root.innerHTML =
      '<div class="pt-page pt-budget">' +
        '<div class="pt-page-head">' +
          '<div><h1 class="pt-h1">計畫與預算</h1><p class="pt-sub" data-role="stamp"></p></div>' +
          '<button type="button" class="pt-btn pt-btn-ghost" data-act="refresh">重新整理</button>' +
        "</div>" +
        '<div data-role="alert"></div>' +
        '<div data-role="body"></div>' +
      "</div>";
    B.el = root.firstElementChild;
    B.renderedData = null;
    B.el.addEventListener("click", onBudgetClick);
    renderBudget();
  }

  function renderBudget() {
    const B = S.budget;
    if (!B.el) return;
    const btn = B.el.querySelector('[data-act="refresh"]');
    btn.disabled = B.loading;
    btn.textContent = B.loading ? "讀取中…" : "重新整理";
    q(B.el, "stamp").textContent = B.data && B.data.generatedAt ? "資料時間：" + B.data.generatedAt : "";
    q(B.el, "alert").innerHTML = B.error && B.data ? '<div class="pt-alert pt-alert-error" role="alert">重新整理失敗：' + esc(B.error) + "</div>" : "";
    const body = q(B.el, "body");
    body.setAttribute("aria-busy", B.loading ? "true" : "false");
    body.classList.toggle("pt-stale", !!(B.loading && B.data));
    if (B.data) {
      if (B.renderedData !== B.data) {
        body.innerHTML = budgetBodyHtml(B.data);
        B.renderedData = B.data;
      }
    } else {
      B.renderedData = null;
      body.innerHTML = B.loading ? loadingHtml("正在讀取預算資料…") : B.error ? errorCardHtml(B.error) : "";
    }
  }

  async function loadBudget(manual) {
    const B = S.budget;
    if (B.loading) return;
    B.loading = true;
    B.error = "";
    renderBudget();
    const res = await call("getBudgetOverview", {}, 60000);
    if (B !== S.budget) return; // 換人登入了
    B.loading = false;
    if (res.ok) {
      B.data = normBudget(res);
      B.fetchedAt = Date.now();
      if (B.center && !B.data.centers.some((c) => c.name === B.center)) B.center = "";
      if (manual) toast("已重新整理");
    } else {
      B.error = res.error;
    }
    renderBudget();
  }

  function onBudgetClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "refresh" || act === "retry") loadBudget(act === "refresh");
    else if (act === "filter") setBudgetCenter(b.dataset.center || "");
    else if (act === "expand") toggleItems(b);
  }

  function setBudgetCenter(name) {
    const B = S.budget;
    if (!B.data || !B.el) return;
    B.center = B.data.centers.some((c) => c.name === name) ? name : "";
    B.el.querySelectorAll('[data-act="filter"]').forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.center || "") === B.center)));
    const view = q(B.el, "view");
    if (view) view.innerHTML = budgetViewHtml(B.data, B.center);
  }

  function toggleItems(btn) {
    const B = S.budget;
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    const panel = document.getElementById(btn.getAttribute("aria-controls"));
    if (panel) panel.hidden = !open;
    const c = B.data && B.data.centers[Number(btn.dataset.ci)];
    const p = c && c.projects[Number(btn.dataset.pi)];
    if (p) {
      const key = c.name + "\n" + p.name;
      if (open) B.expanded.add(key); else B.expanded.delete(key);
    }
  }

  function budgetBodyHtml(d) {
    const footnote = '<p class="pt-footnote">' + FOOTNOTE + "</p>";
    if (!d.centers.some((c) => c.projects.length)) {
      return '<div class="card pt-card"><p class="empty-state pt-empty">目前沒有計畫資料。中心和專案要先在總表設定好，這裡才會出現。</p></div>' + footnote;
    }
    const B = S.budget;
    const filter = d.centers.length > 1
      ? '<div class="pt-filter" role="group" aria-label="依中心篩選">' +
          [{ name: "", label: "全部" }].concat(d.centers.map((c) => ({ name: c.name, label: c.name })))
            .map((o) => '<button type="button" class="pt-fchip" data-act="filter" data-center="' + esc(o.name) + '" aria-pressed="' + (o.name === B.center) + '">' + esc(o.label) + "</button>")
            .join("") +
        "</div>"
      : "";
    return filter + '<div data-role="view">' + budgetViewHtml(d, B.center) + "</div>" + footnote;
  }

  function budgetViewHtml(d, center) {
    const centers = center ? d.centers.filter((c) => c.name === center) : d.centers;
    const totals = center ? sumProjects([].concat(...centers.map((c) => c.projects))) : d.totals;
    return '<h2 class="pt-scope">' + (center ? esc(center) + "合計" : "全部中心合計") + "</h2>" +
      tilesHtml(totals) +
      centers.map((c) => centerBlockHtml(c, d.centers.indexOf(c))).join("");
  }

  function tilesHtml(t) {
    const rate = rateInfo(t.approved, t.budget);
    const remaining = t.budget > 0 ? t.budget - t.approved : null;
    const over = remaining !== null && remaining < 0;
    const tiles = [
      { label: "預算", value: moneyHtml(t.budget), note: t.budget > 0 ? "" : "還沒設定預算金額" },
      { label: "已核准（含已付款）", value: moneyHtml(t.approved), note: rate ? "已用預算 " + rate.text : "" },
      { label: "已付款", value: moneyHtml(t.paid) },
      { label: "審核中", value: moneyHtml(t.pending) },
      { label: "剩餘", value: remaining === null ? "—" : moneyHtml(remaining), over, flag: over ? '<span class="pt-flag pt-flag-over">超支</span>' : "" },
    ];
    return '<dl class="pt-tiles">' + tiles.map((x) =>
      '<div class="pt-tile' + (x.over ? " is-over" : "") + '"><dt>' + x.label + "</dt><dd>" +
        '<span class="pt-tile-value">' + x.value + "</span>" +
        (x.note ? '<span class="pt-tile-note">' + esc(x.note) + "</span>" : "") +
        (x.flag ? '<span class="pt-tile-note">' + x.flag + "</span>" : "") +
      "</dd></div>").join("") + "</dl>";
  }

  function centerBlockHtml(c, ci) {
    // 已結束的專案排到後面，其他照總表順序
    const projects = c.projects.map((p, pi) => ({ p, pi }))
      .sort((a, b) => (Number(isEnded(a.p)) - Number(isEnded(b.p))) || (a.pi - b.pi));
    return '<section class="pt-center-block" aria-labelledby="ptBc' + ci + '">' +
      '<h2 class="pt-h2" id="ptBc' + ci + '">' + esc(c.name) + '<span class="pt-h2-count">' + c.projects.length + " 個專案</span></h2>" +
      (projects.length
        ? '<div class="pt-projects">' + projects.map(({ p, pi }) => projectHtml(c, p, ci, pi)).join("") + "</div>"
        : '<div class="card pt-card"><p class="pt-muted">這個中心還沒有專案。</p></div>') +
    "</section>";
  }

  function projectHtml(c, p, ci, pi) {
    const B = S.budget;
    const open = B.expanded.has(c.name + "\n" + p.name);
    const rate = rateInfo(p.approved, p.budget);
    const rowCount = p.items.length + (p.unassigned.count > 0 ? 1 : 0);
    const panelId = "ptBi" + ci + "-" + pi;
    let meter;
    if (!rate) {
      meter = '<p class="pt-meter-none">還沒設定預算金額</p>';
    } else {
      const left = p.budget - p.approved;
      // 文字放在進度條上面，進度條一律整行寬，各專案的長度才能直接比較
      meter = '<div class="pt-meter-row">' +
        '<p class="pt-meter-text is-' + rate.level + '"><span>已用 <strong>' + rate.text + "</strong></span>" + flagHtml(rate) +
          '<span class="pt-meter-left">' + (left >= 0 ? "剩餘 " + esc(money(left)) : "超出 " + esc(money(-left))) + "</span></p>" +
        '<div class="pt-meter is-' + rate.level + '" aria-hidden="true"><span style="width:' + rate.width.toFixed(2) + '%"></span></div>' +
      "</div>";
    }
    return '<article class="card pt-card pt-proj' + (isEnded(p) ? " is-ended" : "") + '">' +
      '<div class="pt-proj-head"><h3 class="pt-h3">' + esc(p.name) + "</h3>" +
        (p.status ? '<span class="pt-status ' + statusClass(p.status) + '">' + esc(p.status) + "</span>" : "") +
      "</div>" +
      meter +
      '<dl class="pt-nums">' +
        "<div><dt>預算</dt><dd>" + (p.budget > 0 ? esc(money(p.budget)) : '<span class="pt-muted">未設定</span>') + "</dd></div>" +
        "<div><dt>已核准</dt><dd>" + esc(money(p.approved)) + "</dd></div>" +
        "<div><dt>已付款</dt><dd>" + esc(money(p.paid)) + "</dd></div>" +
        "<div><dt>審核中</dt><dd>" + esc(money(p.pending)) + "</dd></div>" +
      "</dl>" +
      (rowCount
        ? '<button type="button" class="pt-expand" data-act="expand" data-ci="' + ci + '" data-pi="' + pi + '" aria-expanded="' + open + '" aria-controls="' + panelId + '">' +
            "<span>預算項目明細（" + rowCount + " 項）</span>" + CHEVRON +
          "</button>" +
          '<div class="pt-items" id="' + panelId + '"' + (open ? "" : " hidden") + ">" + itemsTableHtml(p) + "</div>"
        : '<p class="pt-small pt-muted pt-noitems">還沒有預算項目。</p>') +
    "</article>";
  }

  function itemsTableHtml(p) {
    const dash = '<span class="pt-muted">—</span>';
    const rows = p.items.map((it) => {
      const rate = rateInfo(it.approved, it.budget);
      const left = it.budget > 0 ? it.budget - it.approved : null;
      return "<tr>" +
        "<td>" + (esc(it.category) || dash) + "</td>" +
        "<td>" + (esc(it.item) || dash) + "</td>" +
        '<td class="num">' + (it.budget > 0 ? plain(it.budget) : '<span class="pt-muted">未設定</span>') + "</td>" +
        '<td class="num">' + plain(it.approved) + "</td>" +
        '<td class="num">' + plain(it.paid) + "</td>" +
        '<td class="num">' + plain(it.pending) + "</td>" +
        '<td class="num' + (left !== null && left < 0 ? " is-neg" : "") + '">' + (left === null ? dash : signedPlain(left)) + "</td>" +
        "<td>" + (rate
          ? '<span class="pt-rate is-' + rate.level + '"><span class="pt-minibar is-' + rate.level + '" aria-hidden="true"><span style="width:' + rate.width.toFixed(2) + '%"></span></span>' +
            '<span class="pt-rate-text">' + rate.text + "</span>" + flagHtml(rate) + "</span>"
          : "") + "</td>" +
      "</tr>";
    });
    const u = p.unassigned;
    if (u.count > 0) {
      rows.push('<tr class="pt-row-unassigned">' +
        '<td colspan="2">未分類（不確定預算項目）<span class="pt-cell-note">' + plain(u.count) + " 筆</span></td>" +
        '<td class="num">' + dash + "</td>" +
        '<td class="num">' + plain(u.approved) + "</td>" +
        '<td class="num">' + plain(u.paid) + "</td>" +
        '<td class="num">' + plain(u.pending) + "</td>" +
        '<td class="num">' + dash + "</td>" +
        "<td></td>" +
      "</tr>");
    }
    return '<div class="pt-table-wrap" role="region" tabindex="0" aria-label="' + esc(p.name) + ' 預算項目明細">' +
      '<table class="pt-table">' +
        '<caption class="sr-only">' + esc(p.name) + " 預算項目明細（金額單位：新台幣元）</caption>" +
        '<thead><tr><th scope="col">預算類別</th><th scope="col">預算項目</th><th scope="col" class="num">預算</th>' +
          '<th scope="col" class="num">已核准</th><th scope="col" class="num">已付款</th><th scope="col" class="num">審核中</th>' +
          '<th scope="col" class="num">剩餘</th><th scope="col">執行率</th></tr></thead>' +
        "<tbody>" + rows.join("") + "</tbody>" +
      "</table></div>" +
      '<p class="pt-table-note">金額單位：新台幣元<span class="pt-swipe-hint">・表格可以左右滑動</span></p>';
  }

  /* ---------------- 對外介面 ---------------- */
  window.Portal = { showHome, showAbout, showBudget, reset };

  // 保險：萬一 app.js 在這支檔案載入前就已經切到這三頁（Portal 還不存在），這裡補畫一次
  try {
    if (typeof isSignedIn === "function" && isSignedIn()) {
      const visible = (id) => { const el = document.getElementById(id); return !!(el && !el.hidden); };
      if (visible("view-home")) showHome();
      if (visible("view-about")) showAbout();
      if (visible("view-budget")) showBudget();
    }
  } catch (e) { /* ignore */ }
})();
