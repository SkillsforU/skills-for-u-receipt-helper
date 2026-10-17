/* ============================================================
   團隊後台：首頁（和小U聊天）／認識組織／計畫與預算／常用工具
   ------------------------------------------------------------
   app.js 每次切到這幾頁（登入後、每次網址 # 改變）都會呼叫對應的函式：
     Portal.showHome()   → 畫在 #homeRoot（和新手導師小U聊天）
     Portal.showAbout()  → 畫在 #aboutRoot（小U 整理的手冊重點、最新消息、手冊、組織架構、團隊成員）
     Portal.showBudget() → 畫在 #budgetRoot（只開放給主管和財務）
     Portal.showTools()  → 畫在 #toolsRoot（常用工具，所有同仁都看得到）
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

  /* ============================================================
     ★ 小U 的設定、常用工具清單：文案都集中在這裡，要改字改這裡就好 ★
     ============================================================ */
  const XIAOU = {
    name: "小U",
    title: "Skills for U 新手導師",
    shortTitle: "新手導師",                                  // 手機版標題列用
    tags: ["ESFJ 執政官", "天秤座", "技職出身"],
    bio: "熱心又細心，關心社會議題，也很愛臺灣。兩本組織手冊我都讀過，有問題隨時問我。",
    note: "回答以手冊為準，拿不準的事再問主管。",
    // 對話的第一則；{name} 會換成登入者的名字（拿不到名字時就只說「嗨！」）
    greeting: "嗨，{name}！我是小U，Skills for U 的新手導師。ESFJ 執政官、天秤座，最喜歡把事情安排得好好的，也最見不得同事卡關。組織的規定、流程、文化，工作上卡住的地方，或只是想聊聊天，都可以找我。",
    faq: ["代墊款怎麼報帳？", "上傳單據後多久會撥款？", "請假要怎麼申請？", "我們的核心價值是什麼？", "新人第一週要做什麼？", "系統用不順可以找誰？"],
    typing: "小U 正在想…",
    typingSlow: "比平常久一點，再等我一下…",                                  // 等超過 20 秒才換成這句
    generalNote: "這只是小U的想法，不是組織規定，結果需要靠自己智慧判斷喔～",   // kind: general 的回答底下
    notConfiguredNote: "我還沒拿到手冊，組織規定的問題暫時答不了，請管理員在「網站後台_資料導入連結」填好手冊連結。",
    overviewLoading: "小U 正在讀手冊、整理重點，第一次大約要半分鐘…",
    // 介紹卡上的「追蹤我們」：用文字標示平台，不放品牌 logo
    social: [
      { platform: "Facebook", name: "Skills for U", url: "https://www.facebook.com/skillsforu2018" },
      { platform: "Facebook", name: "OPEN 技職", url: "https://www.facebook.com/open.skills.to.all" },
      { platform: "Facebook", name: "臺灣技職教育年會", url: "https://www.facebook.com/profile.php?id=61558222603288" },
      { platform: "Instagram", name: "OPEN 技職", url: "https://www.instagram.com/openskillstoall/" },
      { platform: "Threads", name: "OPEN 技職", url: "https://www.threads.com/@openskillstoall" },
    ],
  };

  // 常用工具：status "soon" = 即將推出（卡片不能點）。之後上線改成 "ready" 並填 url
  // （"#finance/upload" 這種站內網址同一頁打開，https:// 開頭的另開分頁）。icon 見 TOOL_ICONS。
  const TOOLS = [
    { name: "名片掃描", desc: "拍名片，自動整理成聯絡人", icon: "card", status: "soon" },
    { name: "會議記錄整理", desc: "上傳錄音或筆記，整理成會議記錄", icon: "notes", status: "soon" },
    { name: "活動照片整理", desc: "依場次分好活動照片，挑出可以用的", icon: "photo", status: "soon" },
    { name: "品牌素材", desc: "Logo、色票、簡報範本一次下載", icon: "brand", status: "soon" },
    { name: "信件與公文範本", desc: "常用的邀請信、感謝信、公文範本", icon: "mail", status: "soon" },
  ];
  const TOOLS_INTRO = "同仁常用的小工具會陸續放在這裡。";
  const TOOLS_NOTE = "想要什麼工具？直接跟小U說，或告訴偉翔。";

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

  // 主選單固定在最上面：捲動時要讓出它蓋住的高度
  function topbarBottom() {
    try {
      const bar = document.querySelector(".topbar");
      const r = bar && bar.getBoundingClientRect();
      return r && r.bottom > 0 ? r.bottom : 0;
    } catch (e) { return 0; }
  }

  // 把 node 捲進畫面。obstruct = 底下固定住的輸入框，要讓出它的高度（瀏覽器內建的 scrollIntoView
  // 不知道它擋住了東西）；內容比畫面高時優先露出開頭，讓人從第一行讀起。上面讓出固定的主選單。
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
      const top = topbarBottom() + 12;
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
    if (img.dataset.ptImg === "news") {   // 最新消息的預覽圖：這一張換成素色底＋媒體名稱
      const thumb = img.closest(".pt-news-thumb");
      if (thumb) thumb.classList.add("is-fallback");
      return;
    }
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
    S.about = { el: null, data: null, renderedData: null, loading: false, error: "", openIdx: -1, newsOpen: false, ov: null, ovLoading: false, ovError: "",
      sub: "intro", colleague: "", chats: {}, composing: false, focusPick: false };
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
    ["homeRoot", "aboutRoot", "budgetRoot", "toolsRoot"].forEach((id) => {
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
  const HISTORY_MAX = 10;       // 每次問的時候帶最近 10 則給後端，追問才接得上前文
  let msgSeq = 0;
  function newId() { msgSeq += 1; return "m" + msgSeq + "x" + Date.now().toString(36); }
  function chatKey() { return "pt.chat.v1." + (S.email || "anon"); }

  // 回答的種類：handbook（手冊或系統說明）、general（一般知識）、chat（打招呼、閒聊、問小U自己）、
  // none（手冊沒寫，回答裡會說可以問誰）。舊版後端沒有 kind：找得到算 handbook，找不到算 none。
  const KINDS = ["handbook", "general", "chat", "none"];
  function answerKind(res) {
    const k = str(res && res.kind).trim();
    if (KINDS.includes(k)) return k;
    return res && res.found === false ? "none" : "handbook";
  }
  // 「知識庫還沒設定」的提醒掛在第一則有這個狀況、而且不是閒聊的回答底下
  function ncNoteTarget(list) { return list.find((m) => m.notConfigured && m.kind !== "chat"); }

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
    return name ? XIAOU.greeting.split("{name}").join(name) : XIAOU.greeting.replace(/，?\{name\}/g, "");
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
    return XIAOU.faq.map((s) => '<button type="button" class="pt-chip-btn" data-act="ask" data-q="' + esc(s) + '">' + esc(s) + "</button>").join("");
  }

  // 小U 的介紹卡。桌機：左邊整張卡；手機：縮成聊天上方一行，按「認識小U」才展開標籤、介紹和追蹤我們
  function profileHtml() {
    return '<aside class="pt-prof" aria-labelledby="ptProfName">' +
      artHtml() +
      '<div class="pt-prof-main">' +
        avatarHtml("lg") +
        '<div class="pt-prof-text">' +
          '<h1 class="pt-prof-name" id="ptProfName">' + esc(XIAOU.name) + "</h1>" +
          '<p class="pt-prof-title"><span class="pt-prof-long">' + esc(XIAOU.title) + '</span><span class="pt-prof-short">' + esc(XIAOU.shortTitle) + "</span></p>" +
        "</div>" +
        '<button type="button" class="pt-prof-toggle" data-act="prof-toggle" aria-expanded="false" aria-controls="ptProfMore">認識小U' + CHEVRON + "</button>" +
      "</div>" +
      '<div class="pt-prof-more" id="ptProfMore">' +
        '<ul class="pt-prof-tags" aria-label="小U 的設定">' + XIAOU.tags.map((t) => '<li class="pt-prof-tag">' + esc(t) + "</li>").join("") + "</ul>" +
        '<p class="pt-prof-bio">' + esc(XIAOU.bio) + "</p>" +
        '<p class="pt-prof-note">' + esc(XIAOU.note) + "</p>" +
        '<div class="pt-follow">' +
          '<h2 class="pt-follow-title" id="ptFollowTitle">追蹤我們</h2>' +
          '<ul class="pt-follow-list" aria-labelledby="ptFollowTitle">' + XIAOU.social.filter((s) => safeUrl(s.url)).map((s) =>
            '<li><a class="pt-follow-link" href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener">' +
              '<span class="pt-follow-platform">' + esc(s.platform) + '</span><span class="sr-only">｜</span>' +
              '<span class="pt-follow-name">' + esc(s.name) + "</span>" +
              '<span class="pt-ext" aria-hidden="true">↗</span><span class="sr-only">（在新分頁開啟）</span></a></li>').join("") +
          "</ul>" +
        "</div>" +
      "</div>" +
    "</aside>";
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
      profileHtml() +
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
    const firstNc = ncNoteTarget(H.messages);
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
      else if (act === "prof-toggle") {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", String(open));
        btn.closest(".pt-prof").classList.toggle("is-open", open);
      }
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
      if (t) t.textContent = XIAOU.typingSlow;
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
      const node = msgNode(ans, ncNoteTarget(H.messages) === ans);
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
    // 每種回答都是一樣的泡泡，不加標籤；差別只在底下的小字：
    // handbook／none／general 有出處就列出處，general 再加一句「只是小U的想法」，chat（閒聊）什麼都不加
    const kind = m.kind || "handbook";
    n.className = "pt-msg pt-msg-bot";
    n.dataset.kind = kind;
    let after = "";
    if (kind !== "chat" && m.sources && m.sources.length) after += '<p class="pt-sources">出處：' + esc(sourcesText(m.sources)) + "</p>";
    if (kind === "general") after += '<p class="pt-note pt-note-general">' + esc(XIAOU.generalNote) + "</p>";
    if (m.notConfigured && showNcNote && kind !== "chat") after += '<p class="pt-note pt-note-nc">' + esc(XIAOU.notConfiguredNote) + "</p>";
    n.innerHTML = botMsgHtml('<div class="pt-bubble"><div class="pt-answer">' + formatAnswer(m.text) + "</div></div>", after);
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
      '<p class="pt-typing-note" data-role="ptext">' + esc(XIAOU.typing) + "</p>");
    return n;
  }

  /* ============================================================
     認識組織：小U 從兩本手冊整理的重點（getAboutOverview，慢）
              ＋手冊、組織架構、團隊成員（getAbout，快）
     兩個分開抓，快的先畫出來；重點第一次要 20～40 秒。
     ============================================================ */
  const NEWS_SHOW = 6;          // 最新消息先列 6 則，其他按「看更多」
  const NEWS_TYPES = ["受訪", "評論", "報導"];
  // 快取版本：about v4（多了 profiles：同事使用手冊）、overview v2（之前的是示範內容）。資料形狀一改就要升版號。
  function aboutKey() { return "pt.about.v4." + (S.email || "anon"); }
  function overviewKey() { return "pt.overview.v2." + (S.email || "anon"); }
  const OLD_CACHE = /^pt\.(about\.v[123]|overview\.v1)\./;
  function purgeOldCaches() {
    try {
      const ss = window.sessionStorage;
      for (let i = ss.length - 1; i >= 0; i -= 1) {
        const k = ss.key(i);
        if (k && OLD_CACHE.test(k)) ss.removeItem(k);
      }
    } catch (e) { /* 存取不了就算了 */ }
  }

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
      story: normStory(res.story),
      // 媒體報導（後端已經照日期新到舊排好）
      news: arr(res.news).filter((n) => n && typeof n === "object").map((n) => ({
        date: str(n.date).trim(),
        type: NEWS_TYPES.includes(str(n.type).trim()) ? str(n.type).trim() : "報導",
        title: str(n.title).trim(),
        outlet: str(n.outlet).trim(),
        url: safeUrl(n.url),
        summary: str(n.summary).trim(),
        image: httpsUrl(n.image), // 預覽圖只收 https://
      })).filter((n) => n.title),
      profiles: normProfiles(res.profiles), // 同事使用手冊（後端只回同意放上網站的人）
    };
  }
  // 「我們是誰」：沿革（時間軸）＋品牌。資料當不可信：缺欄位的那一項整項跳過，連結只收 https://
  function httpsUrl(u) { const s = safeUrl(u); return /^https:\/\//i.test(s) ? s : ""; }
  function normStory(s) {
    if (!s || typeof s !== "object") return null; // 舊後端沒有 story：整塊不顯示
    const milestones = arr(s.milestones).filter((m) => m && typeof m === "object")
      .map((m) => ({ year: str(m.year).trim(), title: str(m.title).trim(), text: str(m.text).trim() }))
      .filter((m) => m.year && m.title && m.text);
    const brands = arr(s.brands).filter((b) => b && typeof b === "object")
      .map((b) => ({
        name: str(b.name).trim(),
        formerly: str(b.formerly).trim(),
        text: str(b.text).trim(),
        links: arr(b.links).filter((l) => l && typeof l === "object")
          .map((l) => ({ platform: str(l.platform).trim(), url: httpsUrl(l.url) }))
          .filter((l) => l.platform && l.url),
      }))
      .filter((b) => b.name && b.text);
    const summary = str(s.summary).trim();
    if (!summary && !milestones.length && !brands.length) return null;
    return { title: str(s.title).trim() || "我們是誰", summary, milestones, brands };
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

  /* ---------- 認識組織的四個子分頁（跟核銷作業一樣放在上方，app.js 依網址的 # 切換） ---------- */
  const ABOUT_SUBS = {
    intro: { title: "認識組織", sub: "組織介紹、我們是誰，和最新的受訪與評論。" },
    culture: { title: "組織文化與工作規範", sub: "小U 從兩本手冊整理的重點，也可以直接打開手冊。" },
    team: { title: "認識團隊", sub: "各中心的主管、專案，和團隊成員。" },
    colleagues: { title: "同事使用手冊", sub: "選一位同事，看他自己寫的使用說明書，也可以跟他的虛擬分身聊聊。" },
  };
  function aboutSubFromHash() {
    const m = (location.hash || "").match(/^#\/?about\/([a-z]+)/);
    return m && ABOUT_SUBS[m[1]] ? m[1] : "intro";
  }

  function showAbout(sub) {
    const root = document.getElementById("aboutRoot");
    if (!root) return;
    try {
      syncUser();
      const A = S.about;
      A.sub = ABOUT_SUBS[sub] ? sub : aboutSubFromHash();
      if (!A.el || !root.contains(A.el)) mountAbout(root);
      else applyAboutSub();
      if (!A.data && !A.loading) loadAbout();
      // 重點整理好了就整個工作階段沿用；還沒設定／暫時不能用的狀態，下次進來再問一次
      if ((!A.ov || A.ov.status !== "ready") && !A.ovLoading) loadOverview();
    } catch (e) {
      renderCrash(root, e);
    }
  }

  // 四個子分頁各一塊（data-panel），一次只顯示一塊：
  //   認識組織：小U整理的介紹（hero）→ 我們是誰 → 最新消息
  //   組織文化與工作規範：手冊重點 → 兩本手冊
  //   認識團隊：組織架構 → 團隊成員
  //   同事使用手冊：選同事 → 他的使用說明書＋跟虛擬分身聊天
  // hero 和手冊重點來自 getAboutOverview（慢），其他來自 getAbout（快），所以分成幾個格子各自畫。
  function mountAbout(root) {
    const A = S.about;
    root.innerHTML =
      '<div class="pt-page pt-about">' +
        '<div class="pt-page-head">' +
          '<div><h1 class="pt-h1" data-role="title"></h1><p class="pt-sub" data-role="subtitle"></p></div>' +
          '<button type="button" class="pt-btn pt-btn-ghost" data-act="refresh">重新整理</button>' +
        "</div>" +
        '<div data-role="alert"></div>' +
        '<div data-role="about-state"></div>' +
        '<div data-panel="intro">' +
          '<div class="pt-ov" data-role="overview"></div>' +
          '<div data-role="story"></div>' +
          '<div data-role="news"></div>' +
        "</div>" +
        '<div data-panel="culture" hidden>' +
          '<div data-role="ov-sections"></div>' +
          '<div data-role="handbooks"></div>' +
        "</div>" +
        '<div data-panel="team" hidden><div data-role="team"></div></div>' +
        '<div data-panel="colleagues" hidden><div data-role="colleagues"></div></div>' +
      "</div>";
    A.el = root.firstElementChild;
    A.renderedData = null;
    A.el.addEventListener("click", onAboutClick);
    bindColleagueChat(A.el);
    applyAboutSub();
    renderOverview();
    renderAbout();
  }

  // 換子分頁：改標題、只顯示那一塊
  function applyAboutSub() {
    const A = S.about;
    if (!A.el) return;
    const meta = ABOUT_SUBS[A.sub] || ABOUT_SUBS.intro;
    q(A.el, "title").textContent = meta.title;
    q(A.el, "subtitle").textContent = meta.sub;
    A.el.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== A.sub; });
    // 從「認識團隊」按某人的「使用說明書」過來：焦點放在選到的那位同事上
    if (A.sub === "colleagues" && A.focusPick) {
      A.focusPick = false;
      const btn = A.el.querySelector('.pt-col-pick[aria-pressed="true"]');
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  function renderAboutButton() {
    const A = S.about;
    const btn = A.el && A.el.querySelector('[data-act="refresh"]');
    if (!btn) return;
    const busy = A.loading || A.ovLoading;
    btn.disabled = busy;
    btn.textContent = busy ? "讀取中…" : "重新整理";
  }

  // getAbout 的部分：我們是誰、最新消息（認識組織）、兩本手冊（組織文化與工作規範）、組織架構和團隊成員（認識團隊）、同事使用手冊。
  // 還沒拿到資料時，讀取中／出錯的提示放在各子分頁共用的 about-state 格子。
  const ABOUT_BOXES = ["story", "news", "handbooks", "team", "colleagues"];
  function renderAbout() {
    const A = S.about;
    if (!A.el) return;
    renderAboutButton();
    q(A.el, "alert").innerHTML = A.error && A.data ? '<div class="pt-alert pt-alert-error" role="alert">重新整理失敗：' + esc(A.error) + "</div>" : "";
    ABOUT_BOXES.forEach((role) => {
      const box = q(A.el, role);
      box.setAttribute("aria-busy", A.loading ? "true" : "false");
      box.classList.toggle("pt-stale", !!(A.loading && A.data));
    });
    const state = q(A.el, "about-state");
    if (A.data) {
      state.innerHTML = "";
      if (A.renderedData !== A.data) {
        q(A.el, "story").innerHTML = storyHtml(A.data.story);
        q(A.el, "news").innerHTML = newsHtml(A.data.news);
        q(A.el, "handbooks").innerHTML = handbooksHtml(A.data.handbooks);
        q(A.el, "team").innerHTML = centersHtml(A.data.centers) + peopleHtml(A.data.people, A.data.profiles);
        A.renderedData = A.data;
        renderColleagues();
        if (A.openIdx >= 0) openHandbook(A.openIdx, false); // 重新整理前開著的手冊繼續開著
      }
    } else {
      A.renderedData = null;
      ABOUT_BOXES.forEach((role) => { q(A.el, role).innerHTML = ""; });
      state.innerHTML = A.loading ? loadingHtml("正在讀取組織資料…") : A.error ? errorCardHtml(A.error) : "";
    }
  }

  // getAboutOverview 的部分：最上面的 hero（或讀取中／沒設定／出錯），以及「我們是誰」底下的手冊重點
  function renderOverview() {
    const A = S.about;
    if (!A.el) return;
    renderAboutButton();
    const top = q(A.el, "overview");
    const secs = q(A.el, "ov-sections");
    [top, secs].forEach((box) => {
      box.setAttribute("aria-busy", A.ovLoading ? "true" : "false");
      box.classList.toggle("pt-stale", !!(A.ovLoading && A.ov));
    });
    if (A.ovLoading && A.ov) return; // 重新整理中：舊內容先留著（變淡），回來再換
    let html = "";
    let sections = "";
    // 「組織文化與工作規範」的手冊重點還沒好的時候，也放同一句小U的話（讀取中／沒設定／出錯）
    if (A.ov) {
      html = (A.ovError ? '<div class="pt-alert pt-alert-error" role="alert">重點沒有更新成功：' + esc(A.ovError) + "</div>" : "") + overviewTopHtml(A.ov);
      sections = A.ov.status === "ready" ? overviewSectionsHtml(A.ov.sections) : overviewTopHtml(A.ov);
    } else if (A.ovLoading) {
      html = xiaouBlockHtml(XIAOU.overviewLoading, { typing: true });
      sections = html;
    } else if (A.ovError) {
      html = xiaouBlockHtml("整理重點的時候出了點問題：" + A.ovError, { retry: true, error: true });
      sections = html;
    }
    top.innerHTML = html;
    secs.innerHTML = sections;
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
    else if (act === "news-more") toggleNews(b);
    else if (act === "pick-col") pickColleague(b.dataset.id);
    else if (act === "col-ask") sendColleagueQuestion(b.dataset.q || b.textContent, e.detail === 0);
    else if (act === "col-clear") clearColleagueChat(e.detail === 0);
    else if (act === "col-retry") retryColleague(b.dataset.id);
    else if (act === "col-jump") jumpToColleagueChat();
    else if (act === "open-manual") {
      const A = S.about;
      if (b.dataset.id && b.dataset.id !== A.colleague) { A.colleague = b.dataset.id; renderColleagues(); }
      A.focusPick = true;
      location.hash = "#about/colleagues";
    }
  }

  /* ---------- 最新消息：受訪與評論 ---------- */
  function newsHtml(list) {
    const A = S.about;
    let inner;
    if (!list.length) {
      inner = '<div class="card pt-card"><p class="empty-state pt-empty">還沒有資料。請管理員在最新消息的試算表貼上文章連結（試算表記在「網站後台_資料導入連結」）。</p></div>';
    } else {
      const extra = list.length - NEWS_SHOW;
      inner = '<ul class="pt-news" id="ptNewsList">' + list.map((n, i) => newsItemHtml(n, i >= NEWS_SHOW && !A.newsOpen)).join("") + "</ul>" +
        (extra > 0
          ? '<button type="button" class="pt-btn pt-btn-ghost pt-news-more" data-act="news-more" aria-expanded="' + !!A.newsOpen + '" aria-controls="ptNewsList">' +
              newsMoreLabel(!!A.newsOpen, extra) + "</button>"
          : "");
    }
    return '<section class="pt-section" aria-labelledby="ptAboutNews"><h2 class="pt-h2" id="ptAboutNews">最新消息：受訪與評論</h2>' + inner + "</section>";
  }
  function newsMoreLabel(open, extra) { return open ? "收起" : "看更多（還有 " + extra + " 則）"; }
  // 一則一張連結預覽卡（像社群貼連結）：上面 16:9 預覽圖，下面標題、媒體・日期・類型、摘要。
  // 整張卡都能點：真正的連結是標題，用 CSS 把它的點擊範圍撐滿整張卡（螢幕報讀只念標題，不會整張卡念一遍）。
  // 沒有圖、圖不是 https、或圖載不到：換成同尺寸的素色底，中間寫媒體名稱（不放品牌 logo）。
  function newsItemHtml(n, hidden) {
    const typeCls = n.type === "受訪" ? "is-interview" : n.type === "評論" ? "is-opinion" : "is-report";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? '<time datetime="' + esc(n.date) + '">' + esc(n.date) + "</time>" : (n.date ? "<span>" + esc(n.date) + "</span>" : "");
    const thumb = '<div class="pt-news-thumb' + (n.image ? "" : " is-fallback") + '">' +
      '<span class="pt-news-thumb-label" aria-hidden="true">' + esc(n.outlet || "最新消息") + "</span>" +
      (n.image ? '<img data-pt-img="news" src="' + esc(n.image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : "") +
    "</div>";
    const title = n.url
      ? '<a class="pt-news-link" href="' + esc(n.url) + '" target="_blank" rel="noopener">' + esc(n.title) + '<span class="sr-only">（在新分頁開啟）</span></a>'
      : esc(n.title);
    const meta = [n.outlet ? '<span class="pt-news-outlet">' + esc(n.outlet) + "</span>" : "", date].filter(Boolean).join('<span aria-hidden="true">・</span>');
    return '<li class="pt-news-item' + (hidden ? " pt-news-extra" : "") + '"' + (hidden ? " hidden" : "") + ">" +
      '<article class="pt-news-card' + (n.url ? " is-link" : "") + '">' +
        thumb +
        '<div class="pt-news-body">' +
          '<h3 class="pt-news-title">' + title + "</h3>" +
          '<p class="pt-news-meta">' + meta + '<span class="pt-badge pt-news-type ' + typeCls + '">' + esc(n.type) + "</span></p>" +
          (n.summary ? '<p class="pt-news-summary">' + esc(n.summary) + "</p>" : "") +
        "</div>" +
      "</article>" +
    "</li>";
  }
  function toggleNews(btn) {
    const A = S.about;
    if (!A.data) return;
    A.newsOpen = btn.getAttribute("aria-expanded") !== "true";
    const items = A.el.querySelectorAll("#ptNewsList .pt-news-item");
    items.forEach((li, i) => {
      if (i < NEWS_SHOW) return;
      li.hidden = !A.newsOpen;
      li.classList.toggle("pt-news-extra", !A.newsOpen);
    });
    btn.setAttribute("aria-expanded", String(A.newsOpen));
    btn.textContent = newsMoreLabel(A.newsOpen, items.length - NEWS_SHOW);
    if (!A.newsOpen) reveal(btn); // 收起後清單變短，把按鈕捲回畫面裡
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

  // 最上面那一格：整理好了是 hero；還沒設定／暫時不能用就是小U的一句話
  function overviewTopHtml(ov) {
    if (ov.status === "notConfigured") {
      return xiaouBlockHtml(ov.message || "手冊還沒設定好，我暫時沒辦法整理重點。請管理員在「網站後台_資料導入連結」填好手冊連結。");
    }
    if (ov.status === "unavailable") {
      return xiaouBlockHtml(ov.message || "我現在沒辦法整理重點，等一下再試試看。", { retry: true });
    }
    return heroHtml(ov);
  }

  /* ---------- 我們是誰：沿革時間軸＋品牌卡片 ---------- */
  function storyHtml(st) {
    if (!st) return "";
    const summary = st.summary ? '<div class="pt-story-summary">' + formatAnswer(st.summary) + "</div>" : "";
    const timeline = st.milestones.length
      ? '<ol class="pt-timeline" aria-label="大事記">' + st.milestones.map((m) =>
          '<li class="pt-tl-item">' +
            '<span class="pt-tl-year">' + esc(m.year) + "</span>" +
            '<div class="pt-tl-body"><p class="pt-tl-title">' + esc(m.title) + '</p><p class="pt-tl-text">' + esc(m.text) + "</p></div>" +
          "</li>").join("") + "</ol>"
      : "";
    const card = summary || timeline
      ? '<div class="card pt-card pt-story-card' + (summary && timeline ? " is-split" : "") + '">' + summary + timeline + "</div>"
      : "";
    const brands = st.brands.length ? '<div class="pt-brand-grid">' + st.brands.map(brandHtml).join("") + "</div>" : "";
    return '<section class="pt-section pt-story" aria-labelledby="ptStoryTitle"><h2 class="pt-h2" id="ptStoryTitle">' + esc(st.title) + "</h2>" + card + brands + "</section>";
  }
  function brandHtml(b) {
    return '<article class="card pt-card pt-brand">' +
      '<div class="pt-brand-head"><h3 class="pt-h3">' + esc(b.name) + "</h3>" +
        (b.formerly ? '<span class="pt-badge pt-brand-was">前身：' + esc(b.formerly) + "</span>" : "") +
      "</div>" +
      '<p class="pt-brand-text">' + esc(b.text) + "</p>" +
      (b.links.length
        ? '<ul class="pt-brand-links">' + b.links.map((l) =>
            '<li><a class="pt-brand-link" href="' + esc(l.url) + '" target="_blank" rel="noopener">' +
              '<span class="sr-only">' + esc(b.name) + " 的 </span>" + esc(l.platform) +
              '<span class="pt-ext" aria-hidden="true">↗</span><span class="sr-only">（在新分頁開啟）</span></a></li>').join("") + "</ul>"
        : "") +
    "</article>";
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
      inner = '<div class="card pt-card"><p class="empty-state pt-empty">手冊還沒設定。請管理員在「網站後台_資料導入連結」填入手冊連結。</p></div>';
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

  function profileFor(person, profiles) {
    const email = person.email.toLowerCase();
    return arr(profiles).find((x) => (email && x.email === email) || x.name === person.name) || null;
  }
  function personHtml(p, profiles) {
    const prof = profileFor(p, profiles);
    const badges = p.approverOf.map((c) => '<span class="pt-badge pt-badge-lead">' + esc(c) + "主管</span>")
      .concat(p.financeRoles.map((r) => '<span class="pt-badge pt-badge-fin">財務・' + esc(r) + "</span>"));
    const email = /^[^\s@<>"']+@[^\s@<>"']+$/.test(p.email)
      ? '<a class="pt-person-email" href="mailto:' + esc(p.email) + '">' + esc(p.email) + "</a>"
      : '<span class="pt-person-email pt-muted">' + (esc(p.email) || "—") + "</span>";
    return '<li class="pt-person">' +
      '<span class="pt-person-name">' + (esc(p.name) || "（未填姓名）") + "</span>" + email +
      '<span class="pt-roles">' + (badges.length ? '<span class="sr-only">角色：</span>' + badges.join("") : "") +
        (prof ? '<button type="button" class="pt-textbtn pt-person-manual" data-act="open-manual" data-id="' + esc(prof.id) + '">使用說明書<span class="sr-only">：' + esc(p.name) + "</span></button>" : "") +
      "</span>" +
    "</li>";
  }
  function peopleHtml(list, profiles) {
    const inner = list.length
      ? '<div class="card pt-card pt-people-card">' +
          '<div class="pt-people-head" aria-hidden="true"><span>姓名</span><span>Email</span><span>角色</span></div>' +
          '<ul class="pt-people">' + list.map((p) => personHtml(p, profiles)).join("") + "</ul>" +
        "</div>"
      : '<div class="card pt-card"><p class="empty-state pt-empty">還沒有成員資料。</p></div>';
    return '<section class="pt-section" aria-labelledby="ptAboutPeople"><h2 class="pt-h2" id="ptAboutPeople">團隊成員' +
      (list.length ? '<span class="pt-h2-count">' + list.length + " 人</span>" : "") + "</h2>" + inner + "</section>";
  }

  /* ============================================================
     同事使用手冊：選一位同事 → 他自己寫的使用說明書＋跟他的虛擬分身聊天
     資料來自「團隊個性化」分頁（只有同意放上網站的人）；聊天只存在這個分頁的記憶體裡，不存瀏覽器、後端也不記錄。
     ============================================================ */
  const COL_CHAT_MAX = 20;
  const COL_FIELDS = [
    ["hours", "工作時段與習慣"], ["contact", "找我最好的方式"], ["feedback", "我喜歡怎麼收到回饋"],
    ["help", "可以找我幫忙的事"], ["life", "興趣與生活"], ["voice", "說話風格"],
  ];
  const COL_SUGGEST = ["介紹一下你自己", "怎麼找你最快？", "你喜歡怎麼收到回饋？", "可以找你幫忙什麼？"];
  const PROFILE_KEYS = ["email", "title", "mbti", "blood", "zodiac", "hours", "contact", "feedback", "help", "life", "voice", "about"];

  function normProfiles(list) {
    return arr(list).filter((p) => p && typeof p === "object").map((p) => {
      const o = { id: str(p.id).trim(), name: str(p.name).trim() };
      PROFILE_KEYS.forEach((k) => { o[k] = str(p[k]).trim(); });
      o.email = o.email.toLowerCase();
      return o;
    }).filter((p) => p.id && p.name);
  }
  // 頭像用名字：中文取後兩個字（王小明 → 小明），英文取字首
  function initialsOf(name) {
    const n = str(name).trim();
    if (!n) return "?";
    if (/^[\x00-\x7F\s]+$/.test(n)) return n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    const chars = Array.from(n.replace(/\s+/g, ""));
    return chars.length >= 3 ? chars.slice(-2).join("") : chars.join("");
  }
  function hueClass(id) {
    let h = 0;
    for (const ch of str(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return "c" + (h % 6);
  }
  function colAvatarHtml(p, size) {
    return '<span class="pt-col-av ' + hueClass(p.id) + (size ? " pt-col-av-" + size : "") + '" aria-hidden="true">' + esc(initialsOf(p.name)) + "</span>";
  }
  function colleagueChat(id) {
    const A = S.about;
    if (!A.chats[id]) A.chats[id] = { messages: [], waiting: false, gen: 0 };
    return A.chats[id];
  }
  function currentColleague() {
    const A = S.about;
    return (A.data ? A.data.profiles : []).find((p) => p.id === A.colleague) || null;
  }

  function renderColleagues() {
    const A = S.about;
    if (!A.el || !A.data) return;
    const box = q(A.el, "colleagues");
    const list = A.data.profiles;
    if (!list.length) {
      box.innerHTML = '<div class="card pt-card"><p class="empty-state pt-empty">還沒有同事放上使用說明書。管理員在資料導入那份試算表的「團隊個性化」分頁新增，「同意放上網站」填「是」就會出現在這裡。</p></div>';
      return;
    }
    if (!list.some((p) => p.id === A.colleague)) A.colleague = list[0].id;
    const sel = currentColleague();
    box.innerHTML =
      '<div class="pt-col-picker" role="group" aria-label="選一位同事">' + list.map((p) =>
        '<button type="button" class="pt-col-pick" data-act="pick-col" data-id="' + esc(p.id) + '" aria-pressed="' + (p.id === sel.id) + '">' +
          colAvatarHtml(p) +
          '<span class="pt-col-pick-text"><span class="pt-col-pick-name">' + esc(p.name) + "</span>" +
            (p.title ? '<span class="pt-col-pick-title">' + esc(p.title) + "</span>" : "") + "</span>" +
        "</button>").join("") +
      "</div>" +
      '<div class="pt-col-body">' + manualHtml(sel) + colChatHtml(sel) + "</div>";
    renderColLog(sel);
    const th = colThreadScroller();
    if (th) th.scrollTop = th.scrollHeight; // 切回聊過的同事：從最新的對話開始看
  }

  function manualHtml(p) {
    const A = S.about;
    const person = (A.data ? A.data.people : []).find((x) => profileFor(x, [p]));
    const tags = [p.mbti && "MBTI " + p.mbti, p.zodiac, p.blood && (/型$/.test(p.blood) ? p.blood : p.blood + " 型")].filter(Boolean);
    const roles = person ? person.approverOf.map((c) => c + "主管").concat(person.financeRoles.map((r) => "財務・" + r)) : [];
    // 每一欄可能寫了好幾段：跟小U的回答一樣分段（只認 **粗體** 和 • 清單，其他一律當純文字）
    const rows = COL_FIELDS.filter((f) => p[f[0]]).map((f) => "<div><dt>" + esc(f[1]) + '</dt><dd class="pt-answer">' + formatAnswer(p[f[0]]) + "</dd></div>").join("");
    return '<article class="card pt-card pt-manual" aria-labelledby="ptManualName">' +
      '<div class="pt-manual-head">' + colAvatarHtml(p, "lg") +
        '<div class="pt-manual-who"><h2 class="pt-manual-name" id="ptManualName">' + esc(p.name) + " 的使用說明書</h2>" +
          (p.title ? '<p class="pt-manual-title">' + esc(p.title) + "</p>" : "") + "</div>" +
      "</div>" +
      (tags.length || roles.length
        ? '<ul class="pt-tags pt-manual-tags">' + tags.map((t) => '<li class="pt-tag">' + esc(t) + "</li>").join("") +
            roles.map((r) => '<li class="pt-tag pt-tag-role">' + esc(r) + "</li>").join("") + "</ul>"
        : "") +
      // 手機上說明書很長，聊天在最下面：給一顆按鈕直接跳過去（桌機聊天固定在右邊，不需要）
      '<button type="button" class="pt-btn pt-btn-ghost pt-col-jump" data-act="col-jump">跟虛擬的' + esc(p.name) + "聊聊</button>" +
      (rows ? '<dl class="pt-manual-list">' + rows + "</dl>" : "") +
      (p.about ? '<div class="pt-manual-about"><h3 class="pt-h3">自我描述</h3><div class="pt-answer">' + formatAnswer(p.about) + "</div></div>" : "") +
      (!rows && !p.about && !tags.length ? '<p class="pt-small pt-muted pt-manual-empty">還沒寫內容。</p>' : "") +
    "</article>";
  }

  function colChatHtml(p) {
    const empty = !colleagueChat(p.id).messages.length;
    const nm = esc(p.name);
    return '<section class="card pt-card pt-chat pt-col-chat" id="ptColChat" aria-label="和虛擬的' + nm + '聊天">' +
      '<p class="pt-col-notice">虛擬的' + nm + "：照本人填的使用說明書回答，不代表本人；要本人決定的事，請直接找本人。</p>" +
      '<div class="pt-thread">' +
        '<div class="pt-msg pt-msg-bot pt-greeting">' +
          colBotHtml(p, '<div class="pt-bubble"><p>嗨，我是虛擬的' + nm + "。想知道怎麼跟我合作、可以找我幫什麼忙，都可以問我。</p></div>") +
        "</div>" +
        '<div class="pt-faq pt-col-suggest" data-role="col-suggest"' + (empty ? "" : " hidden") + ">" +
          '<div class="pt-faq-list" role="group" aria-label="可以這樣問">' +
            COL_SUGGEST.map((t) => '<button type="button" class="pt-chip-btn" data-act="col-ask" data-q="' + esc(t) + '">' + esc(t) + "</button>").join("") +
          "</div>" +
        "</div>" +
        '<div class="pt-log' + (empty ? " is-empty" : "") + '" data-role="col-log" role="log" aria-live="polite" aria-label="和虛擬的' + nm + '的對話"></div>' +
      "</div>" +
      '<form class="pt-composer" data-role="col-form" novalidate>' +
        '<label class="sr-only" for="ptColInput">問虛擬的' + nm + "</label>" +
        '<div class="pt-composer-row">' +
          '<textarea id="ptColInput" class="textarea-input pt-input" data-role="col-input" rows="1" maxlength="500" placeholder="問虛擬的' + nm + '…"></textarea>' +
          '<button type="submit" class="pt-send" data-role="col-send">送出</button>' +
        "</div>" +
        '<div class="pt-composer-foot">' +
          '<p class="pt-composer-hint">按 Enter 送出，Shift + Enter 換行</p>' +
          '<button type="button" class="pt-textbtn" data-act="col-clear"' + (empty ? " hidden" : "") + ">清除對話</button>" +
        "</div>" +
      "</form>" +
    "</section>";
  }
  function colBotHtml(p, bubbleHtml, after) {
    return colAvatarHtml(p) + '<div class="pt-msg-body"><p class="pt-msg-name">虛擬的' + esc(p.name) + "</p>" + bubbleHtml + (after || "") + "</div>";
  }
  function colMsgNode(p, m) {
    const n = document.createElement("div");
    n.dataset.id = m.id;
    if (m.role === "user") {
      n.className = "pt-msg pt-msg-user";
      n.innerHTML = '<div class="pt-msg-body"><div class="pt-bubble"><span class="sr-only">你問：</span>' + esc(m.text) + "</div></div>";
      if (m.error) {
        const r = document.createElement("div");
        r.className = "pt-msg-error";
        r.innerHTML = '<p class="pt-msg-error-text">沒有收到回答：' + esc(m.error) + "</p>" +
          '<button type="button" class="pt-btn pt-btn-ghost pt-btn-sm" data-act="col-retry" data-id="' + esc(m.id) + '">重試</button>';
        n.firstChild.appendChild(r);
      }
      return n;
    }
    n.className = "pt-msg pt-msg-bot";
    n.innerHTML = colBotHtml(p, '<div class="pt-bubble"><div class="pt-answer">' + formatAnswer(m.text) + "</div></div>");
    return n;
  }
  function colTypingNode(p) {
    const n = document.createElement("div");
    n.className = "pt-msg pt-msg-bot pt-msg-pending";
    n.innerHTML = colBotHtml(p, '<div class="pt-bubble pt-typing">' + DOTS + "</div>", '<p class="pt-typing-note">虛擬的' + esc(p.name) + " 正在想…</p>");
    return n;
  }

  // 對話整段照狀態重畫（最多 20 則，很快）；回傳最後一則，給捲動用
  function renderColLog(p) {
    const A = S.about;
    if (!A.el || A.colleague !== p.id) return null;
    const log = q(A.el, "col-log");
    if (!log) return null;
    const C = colleagueChat(p.id);
    log.innerHTML = "";
    C.messages.forEach((m) => log.appendChild(colMsgNode(p, m)));
    if (C.waiting) log.appendChild(colTypingNode(p));
    const empty = !C.messages.length;
    log.classList.toggle("is-empty", empty);
    const sug = q(A.el, "col-suggest");
    if (sug) sug.hidden = !empty;
    const clear = A.el.querySelector('[data-act="col-clear"]');
    if (clear) clear.hidden = empty;
    const send = q(A.el, "col-send");
    if (send) send.disabled = C.waiting;
    A.el.querySelectorAll('[data-act="col-retry"], [data-act="col-ask"]').forEach((b) => { b.disabled = C.waiting; });
    return log.lastElementChild;
  }
  // 桌機：聊天框固定在右邊、對話在框裡自己捲；手機：整頁捲（跟首頁一樣避開底部的輸入框）
  function colThreadScroller() {
    const th = S.about.el && S.about.el.querySelector(".pt-col-chat .pt-thread");
    return th && getComputedStyle(th).overflowY !== "visible" ? th : null;
  }
  function revealColleague(node) {
    if (!node || !node.isConnected) return;
    const th = colThreadScroller();
    if (!th) { reveal(node, S.about.el && S.about.el.querySelector(".pt-col-chat .pt-composer")); return; }
    try {
      const t = th.getBoundingClientRect();
      const r = node.getBoundingClientRect();
      if (!r.height) return;
      let dy = 0;
      if (r.bottom > t.bottom - 8) dy = r.bottom - (t.bottom - 8);
      if (r.top - dy < t.top + 8) dy = r.top - (t.top + 8); // 回答比框高：先看到開頭
      if (Math.abs(dy) >= 1) th.scrollTop += dy;
    } catch (e) { /* 捲不動就算了 */ }
  }
  function jumpToColleagueChat() {
    const A = S.about;
    const chat = A.el && A.el.querySelector(".pt-col-chat");
    if (!chat) return;
    try {
      const top = chat.getBoundingClientRect().top + window.scrollY - topbarBottom() - 12;
      window.scrollTo(0, Math.max(0, top));
    } catch (e) { /* ignore */ }
    // 焦點移到聊天區（不直接點輸入框：手機鍵盤一跳出來，建議問題就被擋住了）
    chat.setAttribute("tabindex", "-1");
    chat.focus({ preventScroll: true });
  }

  function bindColleagueChat(el) {
    const isInput = (t) => t && t.matches && t.matches('[data-role="col-input"]');
    el.addEventListener("submit", (e) => {
      if (!e.target.matches('[data-role="col-form"]')) return;
      e.preventDefault();
      submitColleague();
    });
    el.addEventListener("keydown", (e) => {
      if (!isInput(e.target) || e.key !== "Enter" || e.shiftKey) return;
      // 注音／倉頡選字時按的 Enter 不能送出
      if (e.isComposing || e.keyCode === 229 || S.about.composing) return;
      e.preventDefault();
      submitColleague();
    });
    el.addEventListener("compositionstart", (e) => { if (isInput(e.target)) S.about.composing = true; });
    el.addEventListener("compositionend", (e) => { if (isInput(e.target)) S.about.composing = false; });
    el.addEventListener("focusout", (e) => { if (isInput(e.target)) S.about.composing = false; });
    el.addEventListener("input", (e) => { if (isInput(e.target)) autoGrow(e.target); });
  }
  function submitColleague() {
    const A = S.about;
    const p = currentColleague();
    if (!p || !A.el || colleagueChat(p.id).waiting) return;
    const input = q(A.el, "col-input");
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = "";
    autoGrow(input);
    sendColleagueQuestion(text, false);
  }
  function sendColleagueQuestion(text, refocus) {
    const p = currentColleague();
    if (!p) return;
    const C = colleagueChat(p.id);
    const question = str(text).trim().slice(0, 500);
    if (!question || C.waiting) return;
    const msg = { id: newId(), role: "user", text: question };
    C.messages.push(msg);
    askColleagueFor(p, msg);
    if (refocus && S.about.el) { const input = q(S.about.el, "col-input"); if (input) input.focus(); }
  }
  async function askColleagueFor(p, userMsg) {
    const A = S.about;
    const C = colleagueChat(p.id);
    if (C.waiting) return;
    C.waiting = true;
    const gen = C.gen;
    delete userMsg.error;
    while (C.messages.length > COL_CHAT_MAX) C.messages.shift();
    revealColleague(renderColLog(p));
    const idx = C.messages.indexOf(userMsg);
    const history = C.messages.slice(0, idx < 0 ? C.messages.length : idx)
      .filter((m) => m.role === "assistant" || !m.error)
      .slice(-HISTORY_MAX)
      .map((m) => ({ role: m.role, text: m.text }));
    const res = await call("askColleague", { colleague: p.id, question: userMsg.text, history }, 90000);
    if (A !== S.about || gen !== C.gen) return; // 換人登入或清除對話了：丟掉這個回答
    C.waiting = false;
    if (res.ok) {
      const ans = { id: newId(), role: "assistant", text: str(res.answer).trim() || "這題我答不出來，直接問我本人比較準。" };
      const i = C.messages.indexOf(userMsg);
      if (i >= 0) C.messages.splice(i + 1, 0, ans); else C.messages.push(ans);
      while (C.messages.length > COL_CHAT_MAX) C.messages.shift();
    } else {
      userMsg.error = res.error || "沒有收到回答。";
    }
    const last = renderColLog(p); // 使用者這時候看的是別位同事：只存起來，切回來就看得到
    if (last) revealColleague(res.ok ? last : (A.el.querySelector('.pt-col-chat .pt-msg[data-id="' + userMsg.id + '"]') || last));
  }
  function retryColleague(id) {
    const p = currentColleague();
    if (!p) return;
    const C = colleagueChat(p.id);
    const m = C.messages.find((x) => x.id === id);
    if (m && !C.waiting) askColleagueFor(p, m);
  }
  function clearColleagueChat(refocus) {
    const p = currentColleague();
    if (!p) return;
    const C = colleagueChat(p.id);
    C.gen += 1;
    C.waiting = false;
    C.messages = [];
    renderColLog(p);
    if (refocus && S.about.el) { const input = q(S.about.el, "col-input"); if (input) input.focus(); }
  }
  function pickColleague(id) {
    const A = S.about;
    if (!A.data || !A.data.profiles.some((p) => p.id === id) || id === A.colleague) return;
    A.colleague = id;
    renderColleagues();
    const btn = A.el.querySelector('.pt-col-pick[aria-pressed="true"]');
    if (btn) btn.focus(); // 換完同事，焦點留在選單上
  }

  /* ============================================================
     計畫與預算（只開放給主管和財務）
     ============================================================ */
  const BUDGET_FRESH_MS = 20000; // 20 秒內切回來直接用剛抓的資料
  const FOOTNOTE = "已用金額來自收支總表：已核准（含已付款）的單據才算已用，被退回的不算。預算金額請在總表「預算項目設定」分頁的「預算金額」欄填寫。";
  // 金流表模式（後端回 source: "cashflow"）：數字來自當年度金流表的「網站摘要」分頁，網站只顯示總結。
  // 預算＝全年（1–12 月，還沒結算的月份是預估），已付款＝已結算（1 月到結算月），剩餘＝全年減已結算。
  function cfMonths(d) {
    const m = d.settledMonth;
    const range = (a, b) => (a === b ? a + " 月" : a + "–" + b + " 月");
    return {
      settled: m > 0 ? range(1, m) : "",
      left: m > 0 && m < 12 ? range(m + 1, 12) : "",
    };
  }
  function cfFootnote(d) {
    const mm = cfMonths(d);
    let how;
    if (!mm.settled) how = "：已結算是已經結算月份的實際支出，全年是已結算加上還沒結算月份的預估";
    else if (!mm.left) how = "，結算到 12 月：全年和已結算都是 1–12 月的實際支出";
    else how = "，結算到 " + d.settledMonth + " 月：已結算是 " + mm.settled + "的實際支出，全年是已結算加上 " + mm.left + "的預估";
    return "數字來自" + (d.year ? " " + d.year + " 年" : "") + "金流表的「網站摘要」分頁" + how + "，剩餘是全年減已結算。數字有問題請找會計，在金流表修正。";
  }

  function normProject(p) {
    p = p && typeof p === "object" ? p : {};
    const u = p.unassigned && typeof p.unassigned === "object" ? p.unassigned : {};
    return {
      name: str(p.name).trim() || "（未命名專案）",
      status: str(p.status).trim(),
      own: p.own === true, // 金流表模式：中心本身的人事費、業務費
      budget: num(p.budget), approved: num(p.approved), paid: num(p.paid), pending: num(p.pending),
      items: arr(p.items).filter((it) => it && typeof it === "object").map((it) => ({
        category: str(it.category).trim(), item: str(it.item).trim(),
        budget: num(it.budget), approved: num(it.approved), paid: num(it.paid), pending: num(it.pending), count: num(it.count),
        missing: it.missing === true, // 金流表模式：這一列在金流表找不到數字
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
    const cashflow = str(res.source).trim() === "cashflow";
    return {
      generatedAt: str(res.generatedAt).trim(), totals, centers, cashflow,
      year: cashflow ? str(res.year).trim() : "",
      settledMonth: cashflow ? Math.max(0, Math.min(12, Math.floor(num(res.settledMonth)))) : 0,
      warnings: cashflow ? arr(res.warnings).map((w) => str(w).trim()).filter(Boolean).slice(0, 20) : [],
    };
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
    const stamp = [];
    if (B.data && B.data.cashflow) stamp.push((B.data.year ? B.data.year + " 年金流表" : "金流表") + (B.data.settledMonth ? "・結算到 " + B.data.settledMonth + " 月" : ""));
    if (B.data && B.data.generatedAt) stamp.push("資料時間：" + B.data.generatedAt);
    q(B.el, "stamp").textContent = stamp.join("・");
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
    const footnote = '<p class="pt-footnote">' + esc(d.cashflow ? cfFootnote(d) : FOOTNOTE) + "</p>";
    const warn = d.warnings.length
      ? '<div class="pt-alert pt-alert-warn" role="status"><p>金流表有 ' + d.warnings.length + " 列找不到數字，下面先算 0：</p>" +
          '<ul class="pt-alert-list">' + d.warnings.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul></div>"
      : "";
    if (!d.centers.some((c) => c.projects.length)) {
      return warn + '<div class="card pt-card"><p class="empty-state pt-empty">' +
        (d.cashflow ? "金流表的「網站摘要」分頁還沒有資料列。" : "目前沒有計畫資料。中心和專案要先在總表設定好，這裡才會出現。") +
        "</p></div>" + footnote;
    }
    const B = S.budget;
    const filter = d.centers.length > 1
      ? '<div class="pt-filter" role="group" aria-label="依中心篩選">' +
          [{ name: "", label: "全部" }].concat(d.centers.map((c) => ({ name: c.name, label: c.name })))
            .map((o) => '<button type="button" class="pt-fchip" data-act="filter" data-center="' + esc(o.name) + '" aria-pressed="' + (o.name === B.center) + '">' + esc(o.label) + "</button>")
            .join("") +
        "</div>"
      : "";
    return warn + filter + '<div data-role="view">' + budgetViewHtml(d, B.center) + "</div>" + footnote;
  }

  function budgetViewHtml(d, center) {
    const centers = center ? d.centers.filter((c) => c.name === center) : d.centers;
    const totals = center ? sumProjects([].concat(...centers.map((c) => c.projects))) : d.totals;
    return '<h2 class="pt-scope">' + (center ? esc(center) + "合計" : "全部中心合計") + "</h2>" +
      (d.cashflow ? cfTilesHtml(totals, d) : tilesHtml(totals)) +
      centers.map((c) => centerBlockHtml(c, d.centers.indexOf(c), d)).join("");
  }

  // 金流表模式的上方數字：全年／已結算／剩餘（不標超支、接近上限：已結算本來就算在全年裡面）
  function cfTilesHtml(t, d) {
    const mm = cfMonths(d);
    const rate = rateInfo(t.paid, t.budget);
    const left = t.budget - t.paid;
    const tiles = [
      { label: "全年（1–12 月）", value: moneyHtml(t.budget), note: mm.left ? "含 " + mm.left + "預估" : "" },
      { label: "已結算" + (mm.settled ? "（" + mm.settled + "）" : ""), value: moneyHtml(t.paid), note: rate ? "執行率 " + rate.text : "" },
      { label: "剩餘" + (mm.left ? "（" + mm.left + "）" : ""), value: moneyHtml(left), over: left < 0 },
    ];
    return '<dl class="pt-tiles pt-tiles-3">' + tiles.map((x) =>
      '<div class="pt-tile' + (x.over ? " is-over" : "") + '"><dt>' + esc(x.label) + "</dt><dd>" +
        '<span class="pt-tile-value">' + x.value + "</span>" +
        (x.note ? '<span class="pt-tile-note">' + esc(x.note) + "</span>" : "") +
      "</dd></div>").join("") + "</dl>";
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

  function centerBlockHtml(c, ci, d) {
    // 已結束的專案排到後面，其他照總表順序
    const projects = c.projects.map((p, pi) => ({ p, pi }))
      .sort((a, b) => (Number(isEnded(a.p)) - Number(isEnded(b.p))) || (a.pi - b.pi));
    // 金流表模式：「中心營運」不算專案
    const count = d && d.cashflow ? c.projects.filter((p) => !p.own).length : c.projects.length;
    return '<section class="pt-center-block" aria-labelledby="ptBc' + ci + '">' +
      '<h2 class="pt-h2" id="ptBc' + ci + '">' + esc(c.name) + (count ? '<span class="pt-h2-count">' + count + " 個專案</span>" : "") + "</h2>" +
      (projects.length
        ? '<div class="pt-projects">' + projects.map(({ p, pi }) => (d && d.cashflow ? cfProjectHtml(c, p, ci, pi) : projectHtml(c, p, ci, pi))).join("") + "</div>"
        : '<div class="card pt-card"><p class="pt-muted">這個中心還沒有專案。</p></div>') +
    "</section>";
  }

  // 金流表模式的專案卡片：已結算比例、全年／已結算／剩餘；有兩列以上（例如人事費用、營運費用）才有明細
  function cfProjectHtml(c, p, ci, pi) {
    const B = S.budget;
    const open = B.expanded.has(c.name + "\n" + p.name);
    const rate = rateInfo(p.paid, p.budget);
    const missing = p.items.filter((it) => it.missing).length;
    const panelId = "ptBi" + ci + "-" + pi;
    const left = p.budget - p.paid;
    let meter;
    if (!rate) {
      meter = '<p class="pt-meter-none">' + (missing ? "金流表找不到這一項的數字" : "全年金額是 0") + "</p>";
    } else {
      meter = '<div class="pt-meter-row">' +
        '<p class="pt-meter-text is-ok"><span>已結算 <strong>' + rate.text + "</strong></span>" +
          '<span class="pt-meter-left">剩餘 ' + esc(left < 0 ? "−" + money(-left) : money(left)) + "</span></p>" +
        '<div class="pt-meter is-ok" aria-hidden="true"><span style="width:' + rate.width.toFixed(2) + '%"></span></div>' +
      "</div>";
    }
    const showItems = p.items.length > 1;
    return '<article class="card pt-card pt-proj' + (p.own ? " is-own" : "") + '">' +
      '<div class="pt-proj-head"><h3 class="pt-h3">' + esc(p.name) + "</h3></div>" +
      meter +
      '<dl class="pt-nums pt-nums-3">' +
        "<div><dt>全年</dt><dd>" + esc(money(p.budget)) + "</dd></div>" +
        "<div><dt>已結算</dt><dd>" + esc(money(p.paid)) + "</dd></div>" +
        "<div><dt>剩餘</dt><dd>" + esc(left < 0 ? "−" + money(-left) : money(left)) + "</dd></div>" +
      "</dl>" +
      (missing && p.items.length > 1 ? '<p class="pt-small pt-cf-missing">有 ' + missing + " 項在金流表找不到數字，先算 0。</p>" : "") +
      (showItems
        ? '<button type="button" class="pt-expand" data-act="expand" data-ci="' + ci + '" data-pi="' + pi + '" aria-expanded="' + open + '" aria-controls="' + panelId + '">' +
            "<span>明細（" + p.items.length + " 項）</span>" + CHEVRON +
          "</button>" +
          '<div class="pt-items" id="' + panelId + '"' + (open ? "" : " hidden") + ">" + cfItemsTableHtml(p) + "</div>"
        : "") +
    "</article>";
  }

  function cfItemsTableHtml(p) {
    const dash = '<span class="pt-muted">—</span>';
    const rows = p.items.map((it) => {
      if (it.missing) {
        return '<tr class="pt-row-missing"><td>' + (esc(it.category) || dash) + "</td>" +
          '<td class="num"><span class="pt-muted">找不到</span></td><td class="num">' + dash + '</td><td class="num">' + dash + "</td><td></td></tr>";
      }
      const rate = rateInfo(it.paid, it.budget);
      const left = it.budget - it.paid;
      return "<tr>" +
        "<td>" + (esc(it.category) || dash) + "</td>" +
        '<td class="num">' + plain(it.budget) + "</td>" +
        '<td class="num">' + plain(it.paid) + "</td>" +
        '<td class="num' + (left < 0 ? " is-neg" : "") + '">' + signedPlain(left) + "</td>" +
        "<td>" + (rate
          ? '<span class="pt-rate is-ok"><span class="pt-minibar is-ok" aria-hidden="true"><span style="width:' + rate.width.toFixed(2) + '%"></span></span>' +
            '<span class="pt-rate-text">' + rate.text + "</span></span>"
          : "") + "</td>" +
      "</tr>";
    });
    return '<div class="pt-table-wrap" role="region" tabindex="0" aria-label="' + esc(p.name) + ' 明細">' +
      '<table class="pt-table pt-table-cf">' +
        '<caption class="sr-only">' + esc(p.name) + " 明細（金額單位：新台幣元）</caption>" +
        '<thead><tr><th scope="col">類別</th><th scope="col" class="num">全年</th><th scope="col" class="num">已結算</th>' +
          '<th scope="col" class="num">剩餘</th><th scope="col">執行率</th></tr></thead>' +
        "<tbody>" + rows.join("") + "</tbody>" +
      "</table></div>" +
      '<p class="pt-table-note">金額單位：新台幣元<span class="pt-swipe-hint-sm">・表格可以左右滑動</span></p>';
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

  /* ============================================================
     常用工具（所有同仁都看得到；清單在檔案最上面的 TOOLS）
     ============================================================ */
  const TOOL_STATUS = { soon: "即將推出", ready: "可以用了" };
  // 24×24 的簡單線條圖示（不用外部圖檔）
  const TOOL_ICONS = {
    card: '<rect x="3" y="6" width="18" height="13" rx="2"/><circle cx="8.5" cy="11.5" r="2"/><path d="M5.5 16.5c.6-1.4 1.7-2 3-2s2.4.6 3 2M14 10.5h4.5M14 14h3.5"/>',
    notes: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5v4h4M9.5 11.5h6M9.5 14.5h6M9.5 17.5h4"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 15.5l-4.5-4.5L9 18.5M3 17l3.5-3.5 3 3"/>',
    brand: '<circle cx="12" cy="12" r="8.5"/><circle cx="8.6" cy="10" r="1.2"/><circle cx="12" cy="7.6" r="1.2"/><circle cx="15.4" cy="10" r="1.2"/><path d="M12 20.5c-1.5 0-2-1-2-2s1-1.6 2.2-1.6H14c1.7 0 3.4-1.1 3.4-3"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6.5L20.5 7"/>',
  };
  function toolIconHtml(name) {
    const p = TOOL_ICONS[name] || TOOL_ICONS.notes;
    return '<span class="pt-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + p + "</svg></span>";
  }

  function showTools() {
    const root = document.getElementById("toolsRoot");
    if (!root) return;
    try {
      syncUser();
      if (root.querySelector(".pt-tools")) return; // 內容是固定的，畫過就不用再畫
      root.innerHTML =
        '<div class="pt-page pt-tools">' +
          '<div class="pt-page-head"><div><h1 class="pt-h1">常用工具</h1><p class="pt-sub">' + esc(TOOLS_INTRO) + "</p></div></div>" +
          '<ul class="pt-tool-grid">' + TOOLS.map(toolCardHtml).join("") + "</ul>" +
          '<p class="pt-tools-note">' + esc(TOOLS_NOTE) + "</p>" +
        "</div>";
    } catch (e) {
      renderCrash(root, e);
    }
  }
  function toolCardHtml(t) {
    const ready = t.status === "ready" && t.url;
    const external = ready && /^https?:\/\//i.test(t.url);
    const href = ready ? (external ? safeUrl(t.url) : (/^#[\w/-]*$/.test(t.url) ? t.url : "")) : "";
    return '<li class="card pt-card pt-tool' + (href ? "" : " is-soon") + '">' +
      toolIconHtml(t.icon) +
      '<h2 class="pt-tool-name">' + esc(t.name) + "</h2>" +
      '<p class="pt-tool-desc">' + esc(t.desc) + "</p>" +
      '<div class="pt-tool-foot">' +
        (href
          ? '<a class="pt-btn pt-btn-primary" href="' + esc(href) + '"' + (external ? ' target="_blank" rel="noopener"' : "") + ">打開" + esc(t.name) +
              (external ? '<span class="sr-only">（在新分頁開啟）</span>' : "") + "</a>"
          : '<span class="pt-badge pt-badge-soon">' + esc(TOOL_STATUS[t.status] || TOOL_STATUS.soon) + "</span>") +
      "</div>" +
    "</li>";
  }

  /* ---------------- 對外介面 ---------------- */
  purgeOldCaches(); // 舊版快取（例如示範內容的手冊重點）一載入就清掉
  window.Portal = { showHome, showAbout, showBudget, showTools, reset };

  // 保險：萬一 app.js 在這支檔案載入前就已經切到這三頁（Portal 還不存在），這裡補畫一次
  try {
    if (typeof isSignedIn === "function" && isSignedIn()) {
      const visible = (id) => { const el = document.getElementById(id); return !!(el && !el.hidden); };
      if (visible("view-home")) showHome();
      if (visible("view-about")) showAbout(aboutSubFromHash());
      if (visible("view-budget")) showBudget();
      if (visible("view-tools")) showTools();
    }
  } catch (e) { /* ignore */ }
})();
