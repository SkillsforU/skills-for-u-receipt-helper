/**
 * Skills for U｜核銷小幫手 — Google Sheets / Drive 同步 + 中心審核 + Slack 通知
 *
 * ── 組織架構 ───────────────────────────────────────────────
 * 「中心」是最上層（例如組織發展中心、組織行銷中心、人才培育中心），審核表現在「一個中心一份」，
 * 底下的「專案」共用同一份審核表，靠「所屬專案」欄分辨每一列屬於哪個專案。審核人也是設在中心層級，
 * 一個中心底下所有專案都由同一批人審核。Drive 資料夾結構是「中心／專案／年月」。
 *
 * ── 第一次設定 ─────────────────────────────────────────────
 * 1. 開一個 Google 試算表（這份就是「總表」），選單「擴充功能」→「Apps Script」，把這個檔案整份貼進去。
 * 2. 修改下面「機密設定區」：GEMINI_API_KEY、SLACK_WEBHOOK_URL、GOOGLE_CLIENT_ID（Google 登入用戶端 ID）。
 *    （v2 起不再需要 SECRET_TOKEN 密碼，改用「Google 登入」驗證身分。）
 * 3. 右上角「部署」→「新增部署作業」→「網頁應用程式」：執行身分「我」、誰可以存取「任何人」。
 *    把拿到的 /exec 網址寫進前端 app.js（沒有機密，網址不再帶密碼）。
 *    存取權雖是「任何人」，但每次寫入都會驗證 Google 登入證明，只有組織帳號（@skillsforu.org）通得過。
 * 4. 重新整理總表，上方會多一個「核銷小幫手」選單，點「① 建立/更新設定與審核表」。
 *    這會建立「人員設定」「中心設定」「專案設定」「預算項目設定」「會計科目設定」幾個分頁
 *    （第一次會用下面的種子名單預填），並依「中心設定」幫每個進行中的中心建立審核試算表、設好權限、分享給審核人。
 * 5. 點「② 設定自動排程」安裝定時任務。
 *
 * ── 之後要異動人員、中心或專案，不用再改程式碼 ──────────────
 * 直接編輯總表對應的設定分頁即可，改完再點一次「① 建立/更新設定與審核表」。
 * 中心或專案結束就把「狀態」改成「已結束」：上傳選單不再出現、Slack 提醒會跳過，
 * 但審核表與歷史資料都保留（稽核用），不會被刪除。
 *
 * ── 表格版面 ───────────────────────────────────────────────
 * 總表跟各中心審核表都是「第 1 列留給人工填寫的標註（例如哪些欄位是自動帶入、哪些要手動填、由誰填），
 * 第 2 列才是真正的欄位標題，資料從第 3 列開始」。程式只會讀寫第 3 列以後，不會去動第 1 列。
 *
 * ── 權限模型 ───────────────────────────────────────────────
 * 每個中心有自己獨立的審核試算表，只分享給該中心的審核人（編輯者）。
 * 表內除了「審核狀態／審核人／審核備註」三欄之外全部鎖定，
 * 所以審核人只能改審核結果，不能竄改單據原始資料或付款日期。
 * ⚠️ 這是 Google Sheets 平台本身的限制：檔案「擁有者」永遠能繞過這個保護，不受影響。
 *
 * ── 安全性提醒 ─────────────────────────────────────────────
 * 網頁應用程式設成「任何人」可存取，但每次寫入都會驗證 Google 登入證明（見 verifyRequestIdentity_）：
 * 必須是本系統的用戶端 ID、Email 已驗證、且網域是 @skillsforu.org 才准寫資料。
 * 所以就算拿到 /exec 網址也無法寫入——沒有組織帳號的有效登入就會被擋。
 * GOOGLE_CLIENT_ID 不是機密（可公開、會寫進前端）；GEMINI_API_KEY 與 SLACK_WEBHOOK_URL 才是機密，不要外流。
 * 要收回某人存取權：把他從 Google Workspace 停用即可，不需要像舊版那樣換密碼重部署。
 */

/* ============================================================
   機密設定區（只有這裡需要改程式碼）
   ============================================================ */
const SHEET_NAME = '收支總表';     // 總表裡要寫入的分頁名稱，找不到會自動建立
const DRIVE_FOLDER_ID = '';        // 留空 = 自動在「我的雲端硬碟」建立「核銷小幫手」資料夾

// v2 起改用「Google 登入」驗證身分，取代舊的 SECRET_TOKEN 密碼。
// 前端會要求同事用組織帳號（@skillsforu.org）登入 Google，拿到一張「身分證明」(ID token)
// 隨每次請求送來；這裡驗證那張證明是不是真的、是不是這個系統的、是不是組織網域，才准寫資料。
// GOOGLE_CLIENT_ID 是在 Google Cloud「用戶端」建立的網頁應用程式用戶端 ID（不是機密，可公開）。
const GOOGLE_CLIENT_ID = '367734743259-m1si6lu02113c1e53v80t4gnf40poop0.apps.googleusercontent.com';
const ALLOWED_EMAIL_DOMAIN = 'skillsforu.org'; // 只允許這個網域的 Google 帳號使用
const SECRET_TOKEN = '';           // 已停用（保留常數避免其他參照壞掉）；驗證改看 Google 登入
const GEMINI_API_KEY = '';         // 留空 = 不啟用雲端 OCR
// 預設用 gemini-flash-latest 這個別名，它會自動指向目前最新的 Flash 模型，
// 不會因為 Google 淘汰舊版本（回傳 404 no longer available）而突然失效。
const GEMINI_MODEL = 'gemini-flash-latest';
const SLACK_WEBHOOK_URL = '';      // 留空 = 不發送任何 Slack 通知，其他功能不受影響

const DIGEST_DAY_OF_MONTH = 10;    // 每月審核日；遇到週六/週日會自動順延到下一個週一

/* ============================================================
   種子名單：只有「第一次」建立設定分頁時會用到，
   之後一律以總表的「人員設定」「專案設定」分頁為準，改這裡不會有作用。
   ============================================================ */
const SEED_PEOPLE = [
  // [姓名, Email, Slack 個人ID]
  ['黃偉翔', 'ceo@skillsforu.org', 'U03KJN0VBL3'],
  ['胡琬茜', 'rosyhu@skillsforu.org', 'U0B56HTQFSR'],
  ['鐘梓豪', 'rein@skillsforu.org', 'U0AKP8GT3B3'],
  ['郭采媛', 'daphnekuo@skillsforu.org', 'U07GAACQALW'],
  ['林新樺', '', ''],
  ['張晏瑄', '', ''],
  ['王嘉麗', '', ''],
  ['羅禎瑩', '', ''],
  ['李唐', '', ''],
];
// 中心是新的最上層：審核表現在「一個中心一份」，底下的專案共用同一份審核表，
// 用「所屬專案」欄位標示每一列屬於哪個專案。審核人也改設在中心層級。
const SEED_CENTERS = [
  // [中心名稱, 審核人Email（逗號分隔）, 狀態, 主資料夾ID]
  ['組織發展中心', 'ceo@skillsforu.org, rosyhu@skillsforu.org', '進行中', ''],
  ['組織行銷中心', 'ceo@skillsforu.org', '進行中', ''],
  ['人才培育中心', 'ceo@skillsforu.org', '進行中', ''],
];
const SEED_PROJECTS = [
  // [專案名稱, 所屬中心, 狀態, 憑證資料夾ID]
  // 每個中心先各自帶一個跟中心同名的「一般行政」專案，代表「不屬於任何特定專案、算中心的一般開銷」。
  ['組織發展中心', '組織發展中心', '進行中', ''],
  ['組織行銷中心', '組織行銷中心', '進行中', ''],
  ['人才培育中心', '人才培育中心', '進行中', ''],
];

/* ============================================================
   欄位定義
   ============================================================ */
// 總表欄位順序。調整時 createRow_ 的寫入順序與下面的欄位位置常數要一起改。
// 第 1 列留給人工填寫的「自動帶入／手動填寫（誰）」標註，程式不會去動它；
// 標題實際寫在第 2 列，真正的資料從第 3 列開始（見 getSheet_ / findRowById_ 等處的列位置）。
const HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '單據類型', '發票日期', '本次金額', '報價總額', '單據內容', '公司名稱', '用途', '預算項目',
  '所屬期間', '付款狀態', '付款方式', '信用卡形式', '還款對象', '收款對象', '付款資訊', '信用卡紙本確認', '關聯報價單',
  '急迫性', '期望撥款日期', '狀態', '審核人', '審核時間', '退回原因', '單據完備', '付款日期', '會計科目',
  '憑證檔名', '憑證雲端連結', '紀錄ID',
];
// ⚠️ 欄位位置一律用下面這些常數，程式各處都不要再直接寫死數字。
// 這樣之後調整 HEADERS 順序時，只要改這一區的數字，其他地方會自動跟著對；
// 漏改一個寫死的數字會讓資料靜靜寫到隔壁欄，而且完全不會報錯——這裡是唯一的真相來源。
// （注意：改這裡「不會」搬動試算表上已經存在的舊資料，那仍然要人工在 Sheets 裡處理。）
const MASTER_UPLOAD_TIME_COL = 1;
const MASTER_UPLOADER_COL = 2;
const MASTER_PROJECT_COL = 3;
const MASTER_DOCTYPE_COL = 4;         // 單據類型：發票／收據／報價單
const MASTER_INVOICE_DATE_COL = 5;
const MASTER_AMOUNT_COL = 6;          // 本次金額（這一筆實際要付/已付的錢；分期時是單期金額）
const MASTER_QUOTE_TOTAL_COL = 7;     // 報價總額（只有報價單會填，用來對照分期已付/尚欠）
const MASTER_ITEMS_COL = 8;
const MASTER_VENDOR_COL = 9;
const MASTER_PURPOSE_COL = 10;
const MASTER_BUDGET_ITEM_COL = 11;
const MASTER_PERIOD_COL = 12;
const MASTER_PAYSTATUS_COL = 13;      // 付款狀態：已付款／未付款（判斷基準＝組織的錢出去了沒）
const MASTER_PAYMETHOD_COL = 14;      // 付款方式：組織信用卡／零用金／組織匯款
const MASTER_CARDFORM_COL = 15;       // 信用卡形式：連結／紙本（僅未付款・組織信用卡）
const MASTER_REPAY_TARGET_COL = 16;   // 還款對象：組織人員／外部廠商
const MASTER_PAYEE_COL = 17;          // 收款對象：實際人名或廠商名
const MASTER_PAYINFO_COL = 18;        // 付款資訊：帳號／刷卡連結
const MASTER_CARD_CONFIRM_COL = 19;   // 信用卡紙本確認：兩項勾選結果
const MASTER_LINKED_QUOTE_COL = 20;   // 關聯報價單：這筆後續款掛在哪張報價單的紀錄ID底下
const MASTER_URGENCY_COL = 21;
const MASTER_EXPECTED_PAYOUT_COL = 22;
const MASTER_STATUS_COL = 23;    // 狀態、審核人、審核時間、退回原因＝連續四欄（同步時整批寫入）
const MASTER_REVIEWER_COL = 24;
const MASTER_REVIEWED_AT_COL = 25;
const MASTER_REJECT_REASON_COL = 26;
const MASTER_COMPLETE_COL = 27;  // 單據完備，由後勤人員手動勾選，放在付款日期前面
const MASTER_PAYDATE_COL = 28;   // 付款日期，由財務手動填，會同步到各中心審核表
const MASTER_GLCODE_COL = 29;    // 會計科目，財務手動選（下拉選單），純總表內部使用，不同步到審核表
const MASTER_FILE_NAME_COL = 30;
const MASTER_FILE_URL_COL = 31;  // 憑證雲端連結，退回時要靠它找到檔案搬到「已退回」資料夾
const MASTER_RECORD_ID_COL = 32;

// 中心審核表裡實際放單據資料的分頁名稱。程式一律用這個名字去找分頁，
// 不能假設它是「這份試算表的第一個分頁」——如果有人在前面手動加了別的分頁
// （例如放使用說明），單據就會寫錯地方，而且不會有任何錯誤提示（真實發生過一次）。
const REVIEW_SHEET_NAME = '待審核單據';

// 中心審核表的欄位（一個中心一份，底下所有專案共用同一份，靠「所屬專案」欄分辨）。
// 除了「審核狀態／審核人／審核備註」三欄，其餘都鎖定唯讀。第 1 列同樣留給人工標註，標題在第 2 列，資料第 3 列起。
const REVIEW_HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '單據類型', '發票日期', '本次金額', '報價總額', '單據內容', '公司名稱', '用途', '預算項目',
  '付款狀態', '付款方式', '還款對象', '收款對象', '付款資訊', '信用卡紙本確認', '急迫性', '期望撥款日期', '關聯報價單', '憑證連結',
  '審核狀態', '審核人', '審核備註', '單據完備', '付款日期', '紀錄ID',
];
const REVIEW_UPLOADER_COL = 2;
const REVIEW_PROJECT_COL = 3;
const REVIEW_DOCTYPE_COL = 4;
const REVIEW_INVOICE_DATE_COL = 5;
const REVIEW_AMOUNT_COL = 6;
const REVIEW_QUOTE_TOTAL_COL = 7;
const REVIEW_ITEMS_COL = 8;
const REVIEW_VENDOR_COL = 9;
const REVIEW_PURPOSE_COL = 10;
const REVIEW_BUDGET_ITEM_COL = 11;
const REVIEW_PAYSTATUS_COL = 12;
const REVIEW_PAYMETHOD_COL = 13;
const REVIEW_REPAY_TARGET_COL = 14;
const REVIEW_PAYEE_COL = 15;
const REVIEW_PAYINFO_COL = 16;
const REVIEW_CARD_CONFIRM_COL = 17;
const REVIEW_URGENCY_COL = 18;
const REVIEW_EXPECTED_PAYOUT_COL = 19;
const REVIEW_LINKED_QUOTE_COL = 20;
const REVIEW_FILE_URL_COL = 21;
const REVIEW_EDITABLE_START_COL = 22; // 審核狀態
const REVIEW_EDITABLE_COL_COUNT = 3;  // 審核狀態、審核人、審核備註（三欄連續，保護範圍靠這個開洞）
const REVIEW_REVIEWER_COL = 23;
const REVIEW_NOTE_COL = 24;
const REVIEW_COMPLETE_COL = 25;       // 單據完備，由總表同步過來（後勤在總表勾選）
const REVIEW_PAYDATE_COL = 26;        // 由總表同步過來，審核人不能改
const REVIEW_RECORD_ID_COL = 27;

const PEOPLE_SHEET_NAME = '人員設定';
const CENTERS_SHEET_NAME = '中心設定';
const PROJECTS_SHEET_NAME = '專案設定';
const BUDGET_SHEET_NAME = '預算項目設定';
const GLCODE_SHEET_NAME = '會計科目設定';
const PEOPLE_HEADERS = ['姓名', 'Email', 'Slack個人ID'];
const CENTERS_HEADERS = ['中心名稱', '審核人Email（逗號分隔）', '狀態', '主資料夾ID', '審核表ID（自動產生，勿手動修改）', '審核表連結'];
const CENTERS_REVIEW_SHEET_ID_COL = 5; // 審核表ID、審核表連結＝第 5~6 欄（兩欄連續，saveCenterReviewSheet_ 一次寫入）
const PROJECTS_HEADERS = ['專案名稱', '所屬中心', '狀態', '憑證資料夾ID'];
const BUDGET_HEADERS = ['專案/中心', '預算類別', '預算項目', '對應會計科目'];
const GLCODE_HEADERS = ['會計科目']; // 財務自己維護這張清單，總表「會計科目」欄的下拉選單直接讀這裡（會自動跟著清單增減）
// 上傳時真的不知道該歸哪一項時的保底選項，每個專案的下拉都會自動附加這個，
// 不需要在「預算項目設定」分頁裡手動幫每個專案各加一列。
const UNSPECIFIED_BUDGET_ITEM = '不確定預算項目';

const STATUS_OPTIONS = ['待審核', '已核准', '已退回'];
const PROJECT_STATUS_ACTIVE = '進行中';
const PROJECT_STATUS_ENDED = '已結束';

// v2 付款結構與報價單相關的選項（前端下拉、後端驗證共用同一組字，避免兩邊打不一樣對不上）
const DOC_TYPE_OPTIONS = ['發票', '收據', '報價單'];
const DOC_TYPE_QUOTE = '報價單';        // 單據類型是報價單＝還沒補正式發票（待補），補上後會被改成發票／收據
const PAY_STATUS_PAID = '已付款';       // 組織的錢已經出去了（組織信用卡、零用金）
const PAY_STATUS_UNPAID = '未付款';     // 組織還沒付（組織匯款、未付款的組織信用卡）
const PAY_STATUS_OPTIONS = [PAY_STATUS_PAID, PAY_STATUS_UNPAID];
const REPAY_TARGET_MEMBER = '組織人員';  // 還款對象＝內部同仁（多半是代墊款）
const REPAY_TARGET_VENDOR = '外部廠商';  // 還款對象＝外部廠商
const REPAY_TARGET_OPTIONS = [REPAY_TARGET_MEMBER, REPAY_TARGET_VENDOR];

/* ============================================================
   設定分頁讀寫（人員設定 / 專案設定）
   ============================================================ */
let _configCache = null; // 同一次執行內只讀一次，避免重複讀表
const MASTER_SPREADSHEET_ID_PROP_ = 'masterSpreadsheetId';

// 可靠取得「總表」本身，不管目前這次執行是被什麼觸發的。
// SpreadsheetApp.getActiveSpreadsheet() 平常在選單、doPost（網頁應用程式）裡確實會拿到總表，
// 但裝在「各專案審核表」上的安裝式觸發條件（onReviewStatusEdit_）觸發時，「使用中的試算表」
// 其實是引發這次編輯的審核表本身，不是總表——這裡如果照舊呼叫 getActiveSpreadsheet()，
// 讀「專案設定」等分頁會在審核表裡找不到、誤以為是空的，甚至把設定分頁新建在審核表裡面
// （就是這次退件通知讀不到任何審核表ID的真正原因）。改成用快取起來的總表 ID 明確指定，
// 不管從哪個情境呼叫都會拿到同一份。
function getMasterSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty(MASTER_SPREADSHEET_ID_PROP_);
  if (cachedId) {
    try {
      return SpreadsheetApp.openById(cachedId);
    } catch (e) {
      // 快取的 ID 失效了（例如總表被搬到別的帳號），往下重新偵測
    }
  }
  // 還沒快取過：這裡假設當下執行環境的「使用中試算表」是正確的（選單、doPost 都是這樣），
  // 抓到後存進 Script Properties，之後任何情境（包括審核表上的觸發條件）都能穩定指到同一份。
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('無法判斷總表試算表。請先從總表本身執行一次選單「① 建立/更新設定與審核表」來初始化。');
  }
  props.setProperty(MASTER_SPREADSHEET_ID_PROP_, active.getId());
  return active;
}

function getOrCreateSheet_(name, headers, seedRows) {
  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    (seedRows || []).forEach(function (row) {
      // 補齊到表頭長度，避免欄數不足
      const padded = row.slice();
      while (padded.length < headers.length) padded.push('');
      sheet.appendRow(padded);
    });
  }
  return sheet;
}

function loadConfig_() {
  if (_configCache) return _configCache;

  const peopleSheet = getOrCreateSheet_(PEOPLE_SHEET_NAME, PEOPLE_HEADERS, SEED_PEOPLE);
  const centersSheet = getOrCreateSheet_(CENTERS_SHEET_NAME, CENTERS_HEADERS, SEED_CENTERS);
  const projectsSheet = getOrCreateSheet_(PROJECTS_SHEET_NAME, PROJECTS_HEADERS, SEED_PROJECTS);
  const budgetSheet = getOrCreateSheet_(BUDGET_SHEET_NAME, BUDGET_HEADERS, []);

  const people = [];
  const peopleLast = peopleSheet.getLastRow();
  if (peopleLast >= 2) {
    peopleSheet.getRange(2, 1, peopleLast - 1, PEOPLE_HEADERS.length).getValues().forEach(function (r) {
      const name = String(r[0] || '').trim();
      if (!name) return;
      people.push({ name: name, email: String(r[1] || '').trim(), slackId: String(r[2] || '').trim() });
    });
  }

  // 中心是新的最上層：審核表、審核人現在都設在這一層，專案只是底下的分類標籤。
  const centers = [];
  const centerLast = centersSheet.getLastRow();
  if (centerLast >= 2) {
    centersSheet.getRange(2, 1, centerLast - 1, CENTERS_HEADERS.length).getValues().forEach(function (r, i) {
      const name = String(r[0] || '').trim();
      if (!name) return;
      centers.push({
        name: name,
        approverEmails: String(r[1] || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean),
        status: String(r[2] || '').trim() || PROJECT_STATUS_ACTIVE,
        folderId: String(r[3] || '').trim(),
        reviewSheetId: String(r[4] || '').trim(),
        rowIndex: i + 2,
      });
    });
  }

  const projects = [];
  const projLast = projectsSheet.getLastRow();
  if (projLast >= 2) {
    projectsSheet.getRange(2, 1, projLast - 1, PROJECTS_HEADERS.length).getValues().forEach(function (r, i) {
      const name = String(r[0] || '').trim();
      if (!name) return;
      projects.push({
        name: name,
        center: String(r[1] || '').trim(),
        status: String(r[2] || '').trim() || PROJECT_STATUS_ACTIVE,
        folderId: String(r[3] || '').trim(),
        rowIndex: i + 2,
      });
    });
  }

  // 依「專案/中心」分組，一個專案對到一份預算項目清單；找不到對應專案的列不會擋住其他資料，單純略過。
  const budgetItemsByProject = {};
  const budgetLast = budgetSheet.getLastRow();
  if (budgetLast >= 2) {
    budgetSheet.getRange(2, 1, budgetLast - 1, BUDGET_HEADERS.length).getValues().forEach(function (r) {
      const project = String(r[0] || '').trim();
      const item = String(r[2] || '').trim();
      if (!project || !item) return; // 專案/中心、預算項目都是必填，缺一就跳過這列
      if (!budgetItemsByProject[project]) budgetItemsByProject[project] = [];
      budgetItemsByProject[project].push({
        category: String(r[1] || '').trim(),
        item: item,
        glCode: String(r[3] || '').trim(),
      });
    });
  }

  _configCache = {
    people: people, centers: centers, projects: projects,
    centersSheet: centersSheet, projectsSheet: projectsSheet,
    budgetItemsByProject: budgetItemsByProject,
  };
  return _configCache;
}

// 給網頁「預算項目」下拉用：該專案設定表裡的項目，永遠加上「不確定預算項目」保底選項。
function budgetItemsForProject_(projectName) {
  const list = (loadConfig_().budgetItemsByProject[projectName] || []).map(function (b) { return b.item; });
  list.push(UNSPECIFIED_BUDGET_ITEM);
  return list;
}

function findProject_(name) {
  const list = loadConfig_().projects;
  for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
  return null;
}
function activeProjects_() {
  return loadConfig_().projects.filter(function (p) { return p.status !== PROJECT_STATUS_ENDED; });
}
function findCenter_(name) {
  const list = loadConfig_().centers;
  for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
  return null;
}
function activeCenters_() {
  return loadConfig_().centers.filter(function (c) { return c.status !== PROJECT_STATUS_ENDED; });
}
function personByEmail_(email) {
  const list = loadConfig_().people;
  const target = String(email || '').trim().toLowerCase(); // Email 大小寫不敏感，人員設定裡打成大寫也對得到
  if (!target) return null;
  for (let i = 0; i < list.length; i++) if (list[i].email && list[i].email.toLowerCase() === target) return list[i];
  return null;
}

// 驗證這次請求帶來的 Google 登入身分。前端每次 POST 會附上一張 Google ID token，
// 這裡呼叫 Google 的 tokeninfo 端點驗證它（不用在 Apps Script 裡自己做密碼學驗簽，這個端點最單純可靠）：
//   1. aud 必須等於我們自己的用戶端 ID（證明這張證明是發給「本系統」的，不是別的網站的）
//   2. email 必須已驗證
//   3. 網域必須是組織網域（hd 欄或 email 結尾），把外部/私人 Google 帳號擋掉
// 通過後回傳登入者的 email 與姓名（姓名去「人員設定」用 email 對出來）。
function verifyRequestIdentity_(body) {
  const idToken = body && body.idToken;
  if (!idToken) return { ok: false, error: '尚未登入或登入已逾期，請用組織帳號重新登入。' };
  let data;
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return { ok: false, error: '登入驗證失敗（登入可能已逾期），請重新登入。' };
    data = JSON.parse(res.getContentText());
  } catch (e) {
    return { ok: false, error: '登入驗證發生問題，請重新登入。（' + e + '）' };
  }
  if (data.aud !== GOOGLE_CLIENT_ID) return { ok: false, error: '登入憑證與本系統不符，請重新登入。' };
  const email = String(data.email || '').toLowerCase();
  const emailVerified = data.email_verified === true || data.email_verified === 'true';
  if (!email || !emailVerified) return { ok: false, error: '無法確認你的 Email，請重新登入。' };
  const domainOk = data.hd === ALLOWED_EMAIL_DOMAIN ||
    email.slice(-(ALLOWED_EMAIL_DOMAIN.length + 1)) === '@' + ALLOWED_EMAIL_DOMAIN;
  if (!domainOk) return { ok: false, error: '請用組織帳號（@' + ALLOWED_EMAIL_DOMAIN + '）登入，這個帳號無法使用本系統。' };
  const person = personByEmail_(email);
  return { ok: true, email: email, name: person ? person.name : email, unknownPerson: !person };
}
function personByName_(name) {
  const list = loadConfig_().people;
  for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
  return null;
}
function approverDisplayName_(email) {
  const p = personByEmail_(email);
  return p ? p.name : email;
}

// 把自動產生的審核表 ID / 連結寫回「中心設定」，之後就靠 ID 找檔案（搬資料夾也不會壞）
function saveCenterReviewSheet_(center, sheetId, url) {
  const cfg = loadConfig_();
  cfg.centersSheet.getRange(center.rowIndex, CENTERS_REVIEW_SHEET_ID_COL, 1, 2).setValues([[sheetId, url]]);
  center.reviewSheetId = sheetId;
}

/* ============================================================
   Web App 入口
   ============================================================ */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    // 驗證 Google 登入身分（取代舊的 SECRET_TOKEN）。authError 讓前端知道是「登入問題」，
    // 可以引導重新登入，而不是當成一般同步失敗。
    const auth = verifyRequestIdentity_(body);
    if (!auth.ok) {
      return jsonOut_({ ok: false, error: auth.error, authError: true });
    }
    if (body.action === 'ocr') {
      // imageDataUrls（陣列）＝ PDF 在瀏覽器端轉成的多頁壓縮圖片；沒有的話退回單一張 imageDataUrl
      const images = Array.isArray(body.imageDataUrls) && body.imageDataUrls.length ? body.imageDataUrls : [body.imageDataUrl];
      return jsonOut_(recognizeReceipt_(images));
    }
    if (body.action === 'getConfig') {
      // 一併回傳「你是誰」，讓前端顯示登入者、並把上傳人自動帶成本人（不再手選）
      const cfg = getConfigForApp_();
      cfg.me = { email: auth.email, name: auth.name, unknownPerson: auth.unknownPerson };
      return jsonOut_(cfg);
    }
    if (body.action === 'getStatuses') {
      return jsonOut_(getAllStatuses_());
    }
    if (body.action === 'getAllRecords') {
      // 「上傳紀錄」頁查全部：回傳收支總表整份，前端自己依上傳人/日期篩選、算報價單分期已付尚欠
      return jsonOut_(getAllRecords_());
    }
    const sheet = getSheet_();
    if (body.action === 'create') {
      // 上傳人一律以登入者為準（後端覆蓋，前端傳什麼都不算數），避免有人冒名送單
      if (body.record) body.record.uploader = auth.name || (body.record && body.record.uploader) || '';
      return jsonOut_(createRow_(sheet, body.record));
    }
    if (body.action === 'update') {
      return jsonOut_(updateRow_(sheet, body.record));
    }
    if (body.action === 'attachFinal') {
      // 報價單補上正式發票/收據（做法 A：同一筆換單，不另開新列）
      return jsonOut_(attachFinalDocument_(body));
    }
    return jsonOut_({ ok: false, error: 'unknown action: ' + body.action });
  } catch (err) {
    // 錯誤訊息會原樣回傳給網頁端，網頁的「☁ 同步失敗：」提示會直接顯示這段文字，
    // 不需要額外寫進試算表；真的要深入排查再看 Apps Script 的「執行項目」即可。
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return jsonOut_({
    ok: true,
    message: '核銷小幫手同步端點運作中，請用 POST 送資料。',
    model: GEMINI_MODEL,
    geminiKeySet: GEMINI_API_KEY ? true : false,
    slackSet: SLACK_WEBHOOK_URL ? true : false,
  });
}

// 給網頁抓「上傳人」「所屬專案」下拉選單用；專案只回傳進行中的
function getConfigForApp_() {
  const cfg = loadConfig_();
  // 每個進行中專案各自的預算項目清單（已含「不確定預算項目」保底選項），
  // 讓網頁選了專案後，「預算項目」下拉能跟著換成該專案自己的清單。
  const budgetItemsByProject = {};
  activeProjects_().forEach(function (p) {
    budgetItemsByProject[p.name] = budgetItemsForProject_(p.name);
  });
  // 專案現在歸在中心底下：先選中心，「所屬專案」下拉再依這個對照表只顯示該中心的專案。
  // 找不到所屬中心、或那個中心已經結案的專案，不會出現在任何中心底下（等於暫時無法被選到），
  // 這是刻意的——寧可看不到，也不要讓人選到一個歸屬不明或已結案中心的專案。
  const activeCenterNames = activeCenters_().map(function (c) { return c.name; });
  const projectsByCenter = {};
  activeCenterNames.forEach(function (name) { projectsByCenter[name] = []; });
  activeProjects_().forEach(function (p) {
    if (projectsByCenter[p.center]) projectsByCenter[p.center].push(p.name);
  });
  return {
    ok: true,
    uploaders: cfg.people.map(function (p) { return p.name; }),
    centers: activeCenterNames,
    projectsByCenter: projectsByCenter,
    projects: activeProjects_().map(function (p) { return p.name; }), // 保留完整清單，供舊版快取／簡單比對用
    budgetItemsByProject: budgetItemsByProject,
  };
}

/* ============================================================
   雲端 OCR（Gemini）
   ============================================================ */
// images：一或多張圖片／PDF 的 data URL 陣列。多張通常是瀏覽器端把多頁 PDF 轉成的各頁壓縮圖片
//（比整份原始 PDF 小很多、辨識較快），也相容單純傳一張圖片或一份原始 PDF。
function recognizeReceipt_(images) {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: '尚未設定 GEMINI_API_KEY，未啟用雲端 OCR' };
  }
  const list = Array.isArray(images) ? images : [images];
  const parsed = list
    .map(function (img) { return String(img || '').match(/^data:(.+);base64,(.*)$/); })
    .filter(Boolean);
  if (parsed.length === 0) return { ok: false, error: '找不到圖片或 PDF 資料' };

  const prompt = '你是台灣財務單據辨識助理。這份文件可能是一張圖片、一份 PDF，或是同一份文件拆成的多張頁面圖片；' +
    '裡面可能只有其中一頁是真正的發票或收據，其他頁可能是空白、附言或其他不相關內容，' +
    '請你自己判斷找出真正屬於發票/收據內容的那一頁來辨識，忽略其他頁。' +
    '這份文件只會包含「一張」發票或收據；如果你發現裡面其實有兩張以上不同的發票或收據，' +
    '請只針對看起來金額最大、或最完整清楚的那一張辨識，並把 "items" 欄位裡註明「偵測到疑似不只一張單據，請人工確認」。' +
    '台灣單據上的日期常常用民國年（例如「115.08.04」「115年8月4日」），也可能是郵局戳章等彎曲印刷的日期，' +
    '請自行判斷年份格式：民國年數字通常在 1 到 200 之間、明顯小於西元年，遇到這種情況要換算成西元年（民國年 + 1911）再輸出；' +
    '如果原本就是西元年（4 位數、例如 2026）則不用換算，直接使用。' +
    '請只回傳以下格式的 JSON，不要有任何其他文字或說明：' +
    '{"invoiceDate": "換算成西元年後、YYYY-MM-DD 格式的發票或收據日期，找不到則為 null", ' +
    '"amount": 總金額數字（不要加逗號或幣別符號），找不到則為 null, ' +
    '"vendor": "店家或憑證抬頭名稱，找不到則為 null", ' +
    '"items": "品項或用途摘要，找不到則為 null", ' +
    '"confidence": 你對這次辨識結果整體正確性的信心百分比，0 到 100 的整數}';

  const payload = {
    contents: [{
      parts: [{ text: prompt }].concat(parsed.map(function (m) {
        return { inline_data: { mime_type: m[1], data: m[2] } };
      })),
    }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  const fetchOpts = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  // Gemini 免費方案偶爾會回 500/503（伺服器忙碌/過載），這是 Google 那端的暫時性問題，
  // 通常等個一兩秒重打一次就會成功——實測沒重試時失敗率高到影響可用性，加上這個明顯改善。
  // 只對 500/503 重試（過載/暫時故障才值得重打），429（額度用完）、4xx（請求本身有問題）
  // 重打也不會變好，直接當作失敗回傳。最多重試 2 次，加起來頂多多等 3 秒左右，
  // 遠低於前端 120 秒的逾時上限，不會讓使用者等到卡住的感覺。
  const RETRYABLE_STATUSES = [500, 503];
  const RETRY_DELAYS_MS = [1000, 2000];
  let res = UrlFetchApp.fetch(url, fetchOpts);
  let status = res.getResponseCode();
  for (let i = 0; i < RETRY_DELAYS_MS.length && RETRYABLE_STATUSES.indexOf(status) !== -1; i++) {
    Utilities.sleep(RETRY_DELAYS_MS[i]);
    res = UrlFetchApp.fetch(url, fetchOpts);
    status = res.getResponseCode();
  }

  if (status !== 200) {
    return { ok: false, error: 'Gemini API 錯誤（狀態碼 ' + status + '）：' + res.getContentText().slice(0, 800) };
  }

  const data = JSON.parse(res.getContentText());
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  if (!text) return { ok: false, error: 'Gemini 沒有回傳可用內容' };

  try {
    return { ok: true, fields: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: '無法解析 Gemini 回傳的 JSON：' + text.slice(0, 200) };
  }
}

/* ============================================================
   總表寫入
   ============================================================ */
// 判斷「第 2 列（標題列）本身是不是空的」，不能用 sheet.getLastRow() === 0 來判斷「要不要初始化」。
// 真實發生過的事故：第 1 列的人工標註只要有任何文字，getLastRow() 就會變成 1（不是 0），
// 讓「標題還沒寫」被誤判成「已經初始化過」而跳過——後果不只是標題沒補上，appendRow() 還會
// 因此把下一筆新資料直接接到第 2 列（標題該在的位置），不是第 3 列，資料整個位移了一格。
// 這裡只在第 2 列「確實整列空白」時才動手寫標題，不會覆蓋任何已經在那裡的內容（不管是舊標題
// 還是不小心跑錯位置的真實資料），避免自動修復反而砸掉資料——真的錯位了要靠人工插入空白列修正。
function headerRowBlank_(sheet, numCols) {
  if (sheet.getLastRow() < 2) return true;
  const row2 = sheet.getRange(2, 1, 1, numCols).getValues()[0];
  return row2.every(function (v) { return String(v || '').trim() === ''; });
}

function getSheet_() {
  const ss = getMasterSpreadsheet_(); // 理由同 getOrCreateSheet_：不能假設「使用中的試算表」一定是總表
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (headerRowBlank_(sheet, HEADERS.length)) {
    // 第 1 列刻意留空，給人工填寫「自動帶入／手動填寫（誰）」的標註用；標題直接寫在第 2 列，
    // 不用 appendRow（那樣會把標題寫到第 1 列去）。真正的資料從第 3 列開始寫入。
    sheet.getRange(2, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(2);
    // 「發票日期」「所屬期間」存的是我們自訂格式的純文字（YYYY-MM-DD / YYYY-MM），
    // 不先設成純文字格式，Sheets 會自動把它們轉成真正的日期儲存格，
    // 之後程式讀回來就會變成 Date 物件而不是原本的字串（例如資料夾名稱變成一長串英文日期）。
    [
      MASTER_INVOICE_DATE_COL, MASTER_PERIOD_COL, MASTER_EXPECTED_PAYOUT_COL,
      MASTER_REVIEWED_AT_COL, MASTER_PAYDATE_COL,
    ].forEach(function (col) {
      sheet.getRange(3, col, sheet.getMaxRows() - 2, 1).setNumberFormat('@');
    });
    // 「單據完備」勾選框改成「每寫入一列才對那一列設定」（見 createRow_ 的 setCompleteCheckbox_），
    // 不在這裡對整欄一次設定——避免任何指令把一大段範圍都當成「有資料」，害 appendRow() 把
    // 新資料接到最後一列後面，而不是接在真正資料該開始的那一列。
    applyGlCodeDropdown_(sheet);
  }
  return sheet;
}

// 「會計科目」欄的下拉選單，來源是「會計科目設定」分頁那張清單本身（活的範圍參照）——
// 財務之後在那張清單增減科目，這裡的下拉會自動跟著變，不用重新執行任何選單或改程式碼。
function applyGlCodeDropdown_(masterSheet) {
  const glSheet = getOrCreateSheet_(GLCODE_SHEET_NAME, GLCODE_HEADERS, []);
  const sourceRange = glSheet.getRange(2, 1, glSheet.getMaxRows() - 1, 1);
  const rule = SpreadsheetApp.newDataValidation().requireValueInRange(sourceRange, true).setAllowInvalid(true).build();
  masterSheet.getRange(3, MASTER_GLCODE_COL, masterSheet.getMaxRows() - 2, 1).setDataValidation(rule);
}

// 只對「單據完備」欄的某一列設定勾選框格式（空格仍然是空的，不會被 getLastRow 算進去）。
function setCompleteCheckbox_(sheet, row, col) {
  sheet.getRange(row, col).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );
}

function getRootFolder_() {
  if (DRIVE_FOLDER_ID) return DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const name = '核銷小幫手';
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

function findOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

// 依中心找資料夾：「中心設定」有填主資料夾ID 就用那個現成資料夾，沒填就在主資料夾底下建同名資料夾
function getCenterFolder_(centerName) {
  const center = findCenter_(centerName);
  if (center && center.folderId) return DriveApp.getFolderById(center.folderId);
  return findOrCreateSubfolder_(getRootFolder_(), centerName || '未分類中心');
}

// 依專案找資料夾，路徑是「中心／專案」：「專案設定」有填憑證資料夾ID 就直接用那個現成資料夾（不管它在哪個中心底下），
// 沒填就在該專案所屬中心的資料夾底下建一個同名子資料夾。
function getProjectFolder_(projectName) {
  const project = findProject_(projectName);
  if (project && project.folderId) return DriveApp.getFolderById(project.folderId);
  const centerFolder = getCenterFolder_(project ? project.center : '');
  return findOrCreateSubfolder_(centerFolder, projectName || '未分類專案');
}

// 專案資料夾底下再依「所屬期間」（YYYY-MM）開 YYYYMM 子資料夾
// period 正常是 "2026-08" 這種文字，但如果 Sheets 把儲存格自動轉成了真正的日期，
// getValues() 讀回來的會是 JS Date 物件——這裡兩種情況都處理，確保資料夾名稱一定是 "202608" 這種格式。
function periodToFolderName_(period) {
  if (!period) return '未分類';
  if (Object.prototype.toString.call(period) === '[object Date]') {
    return Utilities.formatDate(period, 'Asia/Taipei', 'yyyyMM');
  }
  return String(period).replace(/-/g, '');
}

function getMonthFolder_(projectName, period) {
  return findOrCreateSubfolder_(getProjectFolder_(projectName), periodToFolderName_(period));
}

function getRejectedFolder_() {
  return findOrCreateSubfolder_(getRootFolder_(), '已退回');
}

function saveFile_(record) {
  if (!record.fileDataUrl) return '';
  const match = String(record.fileDataUrl).match(/^data:(.+);base64,(.*)$/);
  if (!match) return '';
  const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], record.fileName || 'receipt.jpg');
  return getMonthFolder_(record.project, record.period).createFile(blob).getUrl();
}

function createRow_(sheet, record) {
  const fileUrl = saveFile_(record);
  // 欄位順序必須跟 HEADERS 完全一致（見上方常數區）。改這裡一定要跟著改 HEADERS，並跑驗證腳本。
  sheet.appendRow([
    formatDateTime_(record.uploadedAt), record.uploader, record.project, record.docType || '發票', record.invoiceDate,
    record.amount, record.quoteTotal || '', record.items, record.vendor, record.purpose, record.budgetItem || '', record.period,
    record.payStatus || '', record.payMethod || '', record.cardForm || '', record.repayTarget || '', record.payee || '',
    record.paymentDetail || '', record.cardConfirmNote || '', record.linkedQuoteId || '',
    record.urgent ? '緊急' : '一般', record.expectedPayoutDate || '', statusLabel_(record.status),
    record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
    '', // 單據完備，由後勤人員在總表勾選
    '', // 付款日期，等財務付款後手動填
    '', // 會計科目，由財務在總表用下拉選單手動選，網頁上傳時不會帶任何值
    record.fileName, fileUrl, record.id,
  ]);
  setCompleteCheckbox_(sheet, sheet.getLastRow(), MASTER_COMPLETE_COL); // 只對剛寫入的這一列設勾選框

  // 同步一份到該中心的審核表，供主管審核
  try {
    appendToCenterReviewSheet_(record, fileUrl);
  } catch (err) {
    console.error('寫入中心審核表失敗：' + err);
  }

  // 緊急件立刻發 Slack；一般件等每月審核日提醒
  if (record.urgent) {
    try {
      notifyUrgentToSlack_(record, fileUrl);
    } catch (err) {
      console.error('Slack 緊急通知失敗：' + err);
    }
  }

  return { ok: true, fileUrl: fileUrl };
}

function findRowById_(sheet, id, idCol) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return -1; // 第 1 列標註、第 2 列標題，資料從第 3 列開始
  const ids = sheet.getRange(3, idCol, lastRow - 2, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 3;
  }
  return -1;
}

// 網頁端的「重新同步」按鈕在 record 從沒建立成功時會呼叫這個動作。
// 一旦列已經存在，代表當初的 create 早就成功了——審核狀態／審核人／審核時間／退回原因
// 只會由 Google 試算表那邊的審核流程更動（單向：Sheets → 網頁），絕對不能讓網頁端拿本機
// 可能已經過期的舊副本（例如主管審核完但這台瀏覽器還沒重新整理過）反向蓋掉試算表上的結果。
// 所以這裡刻意「什麼欄位都不動」，只確認這筆紀錄存在即可。
function updateRow_(sheet, record) {
  const rowIndex = findRowById_(sheet, record.id, MASTER_RECORD_ID_COL);
  if (rowIndex === -1) return createRow_(sheet, record); // 從沒建立成功過，補建立
  return { ok: true, note: '此紀錄已存在於總表，審核狀態由 Google 試算表的審核流程管理，未變更任何欄位。' };
}

// 給「上傳紀錄」頁按「重新整理審核狀態」用：回傳總表每一筆的審核狀態與付款日期
function getAllStatuses_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return { ok: true, statuses: {} }; // 第 1 列標註、第 2 列標題，資料從第 3 列開始
  const values = sheet.getRange(3, 1, lastRow - 2, HEADERS.length).getValues();
  const statuses = {};
  values.forEach(function (row) {
    const id = row[MASTER_RECORD_ID_COL - 1];
    if (!id) return;
    statuses[id] = {
      status: row[MASTER_STATUS_COL - 1],
      reviewer: row[MASTER_REVIEWER_COL - 1],
      reviewedAt: formatDateTime_(row[MASTER_REVIEWED_AT_COL - 1]), // Date 安全：formatDateTime_ 對 Date 物件跟文字都能正確處理
      rejectReason: row[MASTER_REJECT_REASON_COL - 1],
      receiptComplete: row[MASTER_COMPLETE_COL - 1] === true || row[MASTER_COMPLETE_COL - 1] === '是' || row[MASTER_COMPLETE_COL - 1] === 'TRUE',
      paidAt: formatDateOnly_(row[MASTER_PAYDATE_COL - 1]),
    };
  });
  return { ok: true, statuses: statuses };
}

// 給「上傳紀錄」頁查全部用：把收支總表整份撈回來（所有人的紀錄）。這裡只忠實回傳資料，
// 篩選（上傳人／日期區間）跟報價單分期的「已付/尚欠」計算都交給前端做，後端不預先過濾。
function getAllRecords_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return { ok: true, records: [] }; // 第 1 列標註、第 2 列標題，資料從第 3 列開始
  const values = sheet.getRange(3, 1, lastRow - 2, HEADERS.length).getValues();
  const records = values.map(function (row) {
    return {
      id: row[MASTER_RECORD_ID_COL - 1],
      uploadedAt: formatDateTime_(row[MASTER_UPLOAD_TIME_COL - 1]),
      uploader: row[MASTER_UPLOADER_COL - 1],
      project: row[MASTER_PROJECT_COL - 1],
      docType: row[MASTER_DOCTYPE_COL - 1],
      invoiceDate: formatDateOnly_(row[MASTER_INVOICE_DATE_COL - 1]),
      amount: row[MASTER_AMOUNT_COL - 1],
      quoteTotal: row[MASTER_QUOTE_TOTAL_COL - 1],
      items: row[MASTER_ITEMS_COL - 1],
      vendor: row[MASTER_VENDOR_COL - 1],
      purpose: row[MASTER_PURPOSE_COL - 1],
      budgetItem: row[MASTER_BUDGET_ITEM_COL - 1],
      period: row[MASTER_PERIOD_COL - 1],
      payStatus: row[MASTER_PAYSTATUS_COL - 1],
      payMethod: row[MASTER_PAYMETHOD_COL - 1],
      cardForm: row[MASTER_CARDFORM_COL - 1],
      repayTarget: row[MASTER_REPAY_TARGET_COL - 1],
      payee: row[MASTER_PAYEE_COL - 1],
      paymentDetail: row[MASTER_PAYINFO_COL - 1],
      linkedQuoteId: row[MASTER_LINKED_QUOTE_COL - 1],
      urgent: row[MASTER_URGENCY_COL - 1] === '緊急',
      expectedPayoutDate: formatDateOnly_(row[MASTER_EXPECTED_PAYOUT_COL - 1]),
      status: row[MASTER_STATUS_COL - 1],
      reviewer: row[MASTER_REVIEWER_COL - 1],
      reviewedAt: formatDateTime_(row[MASTER_REVIEWED_AT_COL - 1]),
      rejectReason: row[MASTER_REJECT_REASON_COL - 1],
      receiptComplete: row[MASTER_COMPLETE_COL - 1] === true || row[MASTER_COMPLETE_COL - 1] === '是' || row[MASTER_COMPLETE_COL - 1] === 'TRUE',
      paidAt: formatDateOnly_(row[MASTER_PAYDATE_COL - 1]),
      glCode: row[MASTER_GLCODE_COL - 1],
      fileName: row[MASTER_FILE_NAME_COL - 1],
      fileUrl: row[MASTER_FILE_URL_COL - 1],
    };
  }).filter(function (r) { return r.id; });
  return { ok: true, records: records };
}

// 報價單補上正式發票/收據（做法 A）：同一筆「換單」，不另開新列，避免金額被重複計算。
// 一個「案子」＝這張報價單那筆（母），加上所有「關聯報價單」指到它的後續款（訂金/尾款）。
// - 換單：把母筆的單據類型改成發票/收據、憑證換成正式發票（舊報價單搬到「報價單存查」只搬不刪），
//   後續款也一起改單據類型，才不會還被當成「待補」。
// - 金額核對：正式發票金額跟原本核准的（單筆＝本次金額；分期＝各期已付加總）不一致時，比照
//   「金額不符退回重做」，把母筆狀態打回「待審核」讓主管重新確認；審核表那列也一起打回，
//   否則隔天的 review→master 審核同步會把舊的「已核准」再推回來，等於沒退成。
function attachFinalDocument_(body) {
  const targetId = body.id;
  if (!targetId) return { ok: false, error: '缺少要補件的紀錄ID' };
  const newDocType = body.docType || '發票';
  if (newDocType === DOC_TYPE_QUOTE) return { ok: false, error: '補件的單據類型不能還是報價單' };

  const sheet = getSheet_();
  const parentRow = findRowById_(sheet, targetId, MASTER_RECORD_ID_COL);
  if (parentRow === -1) return { ok: false, error: '找不到要補件的報價單紀錄（ID: ' + targetId + '）' };

  const lastRow = sheet.getLastRow();
  const all = sheet.getRange(3, 1, lastRow - 2, HEADERS.length).getValues();
  const parent = all[parentRow - 3];
  const project = parent[MASTER_PROJECT_COL - 1];
  const period = parent[MASTER_PERIOD_COL - 1];

  // 存正式發票、把舊報價單檔案搬去存查（只搬不刪，保留軌跡）
  const newFileUrl = saveFile_({ fileDataUrl: body.fileDataUrl, fileName: body.fileName, project: project, period: period });
  try {
    const oldUrl = parent[MASTER_FILE_URL_COL - 1];
    if (oldUrl && newFileUrl) moveReceiptFile_(oldUrl, findOrCreateSubfolder_(getRootFolder_(), '報價單存查'));
  } catch (err) {
    console.error('搬移舊報價單到存查資料夾失敗（不影響補件）：' + err);
  }

  // 這個案子的已付合計＝母筆 + 所有掛在它底下的後續款
  const parentAmount = Number(parent[MASTER_AMOUNT_COL - 1]) || 0;
  let caseSum = parentAmount;
  const childRows = [];
  all.forEach(function (row, i) {
    if (row[MASTER_LINKED_QUOTE_COL - 1] === targetId) {
      caseSum += Number(row[MASTER_AMOUNT_COL - 1]) || 0;
      childRows.push(i + 3);
    }
  });
  const isStaged = childRows.length > 0;
  const invoiceAmount = Number(body.amount);
  const hasInvoiceAmount = body.amount !== undefined && body.amount !== null && body.amount !== '' && !isNaN(invoiceAmount);
  const compareBase = isStaged ? caseSum : parentAmount;
  const amountMismatch = hasInvoiceAmount && invoiceAmount !== compareBase;

  // 換單：母筆的單據類型、憑證、發票日期；後續款只改單據類型（金額不動）
  if (newFileUrl) {
    sheet.getRange(parentRow, MASTER_FILE_NAME_COL).setValue(body.fileName || '');
    sheet.getRange(parentRow, MASTER_FILE_URL_COL).setValue(newFileUrl);
  }
  sheet.getRange(parentRow, MASTER_DOCTYPE_COL).setValue(newDocType);
  if (body.invoiceDate) sheet.getRange(parentRow, MASTER_INVOICE_DATE_COL).setValue(body.invoiceDate);
  childRows.forEach(function (r) { sheet.getRange(r, MASTER_DOCTYPE_COL).setValue(newDocType); });

  // 單筆且金額不符 → 母筆本次金額更新成發票實際金額（分期不動各期金額，只在案子層級標記提醒）
  if (!isStaged && amountMismatch) {
    sheet.getRange(parentRow, MASTER_AMOUNT_COL).setValue(invoiceAmount);
  }

  let reReviewed = false;
  if (amountMismatch) {
    const note = isStaged
      ? '報價分期已付合計 NT$ ' + compareBase + ' 與正式發票 NT$ ' + invoiceAmount + ' 不符，請確認後重新核准。'
      : '報價金額 NT$ ' + compareBase + ' 與正式發票 NT$ ' + invoiceAmount + ' 不符，已更新為發票金額，請重新核准。';
    // 母筆打回待審核：狀態、審核人、審核時間、退回原因四欄連續一次寫入
    sheet.getRange(parentRow, MASTER_STATUS_COL, 1, 4).setValues([['待審核', '', '', note]]);
    try {
      resetReviewRowForReReview_(targetId, project, newDocType, isStaged ? null : invoiceAmount);
    } catch (err) {
      console.error('把審核表打回待審核失敗：' + err);
    }
    reReviewed = true;
  } else {
    // 金額相符：把審核表的單據類型（單筆再帶金額）更新一下，審核狀態不動
    try {
      updateReviewDocType_(targetId, project, newDocType, isStaged ? null : compareBase);
    } catch (err) {
      console.error('更新審核表單據類型失敗（不影響總表）：' + err);
    }
  }

  return { ok: true, fileUrl: newFileUrl, reReviewed: reReviewed, caseSum: caseSum, staged: isStaged };
}

// 找出某筆紀錄在「所屬中心審核表」裡的那一列，回傳 { sheet, row } 或 null
function findReviewRowForRecord_(recordId, projectName) {
  const project = findProject_(projectName);
  if (!project) return null;
  const center = findCenter_(project.center);
  if (!center || !center.reviewSheetId) return null;
  let ss;
  try { ss = SpreadsheetApp.openById(center.reviewSheetId); } catch (e) { return null; }
  const sheet = getReviewSheet_(ss);
  const row = findRowById_(sheet, recordId, REVIEW_RECORD_ID_COL);
  return row === -1 ? null : { sheet: sheet, row: row };
}

// 補件金額相符：只更新審核表的單據類型（單筆再帶本次金額），審核狀態維持不動
function updateReviewDocType_(recordId, projectName, docType, amountOrNull) {
  const loc = findReviewRowForRecord_(recordId, projectName);
  if (!loc) return;
  loc.sheet.getRange(loc.row, REVIEW_DOCTYPE_COL).setValue(docType);
  if (amountOrNull !== null) loc.sheet.getRange(loc.row, REVIEW_AMOUNT_COL).setValue(amountOrNull);
}

// 補件金額不符：更新審核表單據類型/金額，並把審核三欄打回「待審核」清空另兩欄，
// 讓主管重新看到、重新核准（否則隔天 review→master 同步會把舊的已核准推回總表）
function resetReviewRowForReReview_(recordId, projectName, docType, amountOrNull) {
  const loc = findReviewRowForRecord_(recordId, projectName);
  if (!loc) return;
  loc.sheet.getRange(loc.row, REVIEW_DOCTYPE_COL).setValue(docType);
  if (amountOrNull !== null) loc.sheet.getRange(loc.row, REVIEW_AMOUNT_COL).setValue(amountOrNull);
  loc.sheet.getRange(loc.row, REVIEW_EDITABLE_START_COL, 1, REVIEW_EDITABLE_COL_COUNT).setValues([['待審核', '', '']]);
}

function statusLabel_(status) {
  return { pending: '待審核', approved: '已核准', rejected: '已退回' }[status] || status || '待審核';
}

// ISO 時間字串 → GMT+8、精確到分鐘，例如 "2026-07-31 14:23"
function formatDateTime_(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
}

// 付款日期欄可能是 Date 物件（財務用日期選擇器填）或純文字，統一成 yyyy-MM-dd 字串
function formatDateOnly_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'Asia/Taipei', 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  // 「付款日期」是財務直接在試算表手動輸入的（其他日期欄都是網頁自動寫入固定格式），
  // 容許用 - 或 / 當分隔符、月/日不補零（例如 "2026/8/13"），一律正規化成 yyyy-MM-dd，
  // 避免因為格式差一點跟其他地方逐字比對（例如付款月份彙總）就抓不到，卻不會有任何錯誤提示。
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) {
    return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  }
  return s;
}

// 簡單觸發條件：只要有人直接在試算表編輯儲存格就會自動執行，不需要另外設定排程。
// 「付款日期」很自然會被打成沒有年份的簡寫（例如「8/14」），這裡在編輯的當下、
// 用當下真正的年份把它補成完整的 yyyy-MM-dd 直接存回儲存格——
// 刻意不做成「讀取時才推算年份」，那樣隔年才讀到同一格會用當時的年份誤判，資料反而悄悄跑掉。
function onEdit(e) {
  try {
    const range = e && e.range;
    if (!range || range.getSheet().getName() !== SHEET_NAME) return;
    if (range.getColumn() !== MASTER_PAYDATE_COL || range.getNumColumns() !== 1 || range.getNumRows() !== 1) return;
    const value = range.getValue();
    if (!value || Object.prototype.toString.call(value) === '[object Date]') return;
    const bare = String(value).trim().match(/^(\d{1,2})[-\/](\d{1,2})$/); // 只有月/日、沒有年份
    if (!bare) return;
    const year = new Date().getFullYear();
    range.setValue(year + '-' + bare[1].padStart(2, '0') + '-' + bare[2].padStart(2, '0'));
  } catch (err) {
    console.error('onEdit 自動補年份失敗（不影響其他功能）：' + err);
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   建立 / 更新各專案審核表
   ============================================================ */
function setupProjectReviewSheets() {
  // 「會計科目設定」不會被 loadConfig_() 讀到（沒有任何程式邏輯需要讀它的內容，只有下拉選單要用它），
  // 明確在這裡確保它存在，不要只靠總表第一次建立時順便建立——不然像這次一樣，
  // 先跑①、總表還沒建立過的話，會計科目設定根本不會被建出來，讓人以為選單漏做了什麼。
  getOrCreateSheet_(GLCODE_SHEET_NAME, GLCODE_HEADERS, []);

  const created = [];
  const skipped = [];
  const strayNotes = [];
  activeCenters_().forEach(function (center) {
    const ss = getOrCreateCenterSpreadsheet_(center);
    applyCenterPermissions_(ss, center);
    created.push(center.name);
    const stray = strayEditorsOfCenter_(ss, center);
    if (stray.length > 0) strayNotes.push('• ' + center.name + '：' + stray.join('、'));
  });
  loadConfig_().centers.forEach(function (c) {
    if (c.status === PROJECT_STATUS_ENDED) skipped.push(c.name);
  });

  // 有人「有編輯權但不在審核人名單上」時要主動講——系統不會自動收回權限（原因見 strayEditorsOfCenter_）
  const strayBlock = strayNotes.length > 0
    ? '\n\n⚠️ 下列人員有審核表編輯權，但不在「' + CENTERS_SHEET_NAME + '」的審核人名單上：\n' +
      strayNotes.join('\n') +
      '\n系統不會自動收回權限（可能是你刻意分享給會計或稽核的）。\n' +
      '如果是離職或調動要收回，請到該審核表右上角「共用」裡手動移除。'
    : '';

  SpreadsheetApp.getUi().alert(
    '設定分頁與審核表已更新。\n\n' +
    '進行中中心（' + created.length + '）：\n' + (created.join('\n') || '（無）') +
    '\n\n已結束、略過的中心（' + skipped.length + '）：\n' + (skipped.join('\n') || '（無）') +
    strayBlock +
    '\n\n各中心審核表的網址可在「' + CENTERS_SHEET_NAME + '」分頁查看，已自動分享給對應的審核人。\n' +
    '要異動人員、專案、中心或預算項目，直接編輯「' + PEOPLE_SHEET_NAME + '」「' + PROJECTS_SHEET_NAME +
    '」「' + CENTERS_SHEET_NAME + '」「' + BUDGET_SHEET_NAME + '」分頁後再執行一次這個選單即可。'
  );
}

// 標題列、凍結、日期欄純文字格式——不管是「全新建立」還是「既有但被清空」的審核表都要補上，
// 兩種情況共用同一段邏輯，避免總表有這道防線、審核表卻漏掉：有人手動清空審核表內容
// （連標題一起刪）之後，系統就再也長不出標題列。第 1 列同總表，留給人工標註，標題寫在第 2 列，
// 真正的資料從第 3 列開始（審核表現在一個中心一份，多個專案共用同一份表，靠「所屬專案」欄分辨）。
function setupReviewSheetHeaders_(sheet) {
  sheet.getRange(2, 1, 1, REVIEW_HEADERS.length).setValues([REVIEW_HEADERS]);
  sheet.setFrozenRows(2);
  // 避免「發票日期」「期望撥款日期」「付款日期」被 Sheets 自動轉成真正的日期儲存格
  [REVIEW_INVOICE_DATE_COL, REVIEW_EXPECTED_PAYOUT_COL, REVIEW_PAYDATE_COL].forEach(function (col) {
    sheet.getRange(3, col, sheet.getMaxRows() - 2, 1).setNumberFormat('@');
  });
  // 單據完備勾選框改成每寫入一列才對那列設定（見 appendToCenterReviewSheet_），不在這裡對整欄一次設定。
}

// 靠名字找到中心審核表裡實際放單據的分頁，不管它現在排第幾個。
// 找不到（理論上不該發生，保留給非常舊的檔案或極端情況）才退回抓第一個分頁，
// 至少不會直接整個掛掉；正常情況下都應該用得到 REVIEW_SHEET_NAME 那個分頁。
function getReviewSheet_(ss) {
  return ss.getSheetByName(REVIEW_SHEET_NAME) || ss.getSheets()[0];
}

function getOrCreateCenterSpreadsheet_(center) {
  if (center.reviewSheetId) {
    try {
      const existing = SpreadsheetApp.openById(center.reviewSheetId);
      // openById 對「已丟進垃圾桶」的檔案不會報錯，還是打得開——如果不特別檢查，
      // 系統會誤以為審核表還在，繼續往垃圾桶裡的舊檔案寫資料，新的完全不會出現在該出現的資料夾。
      // 這裡刻意不自動重建：垃圾桶裡的檔案 30 天內都還在，可能是誤刪，貿然重建
      // 會讓新舊兩份同時存在，之後有人把舊的救回來反而搞不清楚哪份才是正本。
      // 明確報錯，把「救回來」還是「清空這格讓它重建」的決定交給人來下。
      if (DriveApp.getFileById(center.reviewSheetId).isTrashed()) {
        throw new Error(
          '中心「' + center.name + '」的審核表（ID: ' + center.reviewSheetId + '）目前在垃圾桶裡，' +
          '未自動重建。請到 Google 雲端硬碟垃圾桶把它復原，或是把「' + CENTERS_SHEET_NAME +
          '」分頁裡這個中心的「審核表ID」「審核表連結」兩欄清空後再重新執行這個選單，讓系統建立全新的審核表。'
        );
      }
      const existingSheet = getReviewSheet_(existing);
      // 有人手動把整份審核表的內容清空（連標題列一起刪）時，補回標題，跟總表 getSheet_() 是同一個防線。
      // 判斷方式同樣改成「第 2 列本身是不是空的」，理由見 headerRowBlank_ 的說明——
      // 第 1 列的人工標註有內容時，getLastRow()===0 這個舊判斷法會誤判成「不用補標題」。
      if (headerRowBlank_(existingSheet, REVIEW_HEADERS.length)) setupReviewSheetHeaders_(existingSheet);
      return existing;
    } catch (e) {
      if (String(e).indexOf('目前在垃圾桶裡') !== -1) throw e; // 上面主動拋出的錯誤要讓它往外傳，不能被下面的 catch 吞掉
      // openById 本身失敗（例如檔案被永久刪除），才走到這裡重新建立
    }
  }
  const ss = SpreadsheetApp.create('單據審核 - ' + center.name);
  const sheet = ss.getSheets()[0]; // 全新建立的試算表只有一個分頁，這裡就是要幫它命名，不用查名字
  sheet.setName(REVIEW_SHEET_NAME);
  setupReviewSheetHeaders_(sheet);
  saveCenterReviewSheet_(center, ss.getId(), ss.getUrl());

  // 放進主資料夾下的「中心審核表」子資料夾，方便集中管理
  try {
    DriveApp.getFileById(ss.getId()).moveTo(findOrCreateSubfolder_(getRootFolder_(), '中心審核表'));
  } catch (e) {
    console.error('搬移審核表到資料夾失敗（不影響功能）：' + e);
  }
  return ss;
}

function applyCenterPermissions_(ss, center) {
  const sheet = getReviewSheet_(ss);

  // 1. 分享給審核人（編輯者）
  center.approverEmails.forEach(function (email) {
    try {
      ss.addEditor(email);
    } catch (e) {
      console.error('無法分享給 ' + email + '：' + e);
    }
  });

  // 2. 鎖住整張表，只留審核三欄可編輯。
  //    保護範圍的編輯者只留擁有者，其餘欄位審核人就改不動；
  //    未保護範圍（審核三欄）則是檔案的編輯者（＝審核人）可以改。
  sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  const protection = sheet.protect().setDescription('單據資料與付款日期唯讀，僅開放審核欄位');
  protection.removeEditors(protection.getEditors());
  protection.setUnprotectedRanges([
    sheet.getRange(3, REVIEW_EDITABLE_START_COL, sheet.getMaxRows() - 2, REVIEW_EDITABLE_COL_COUNT),
  ]);

  // 3. 審核狀態、審核人做成下拉選單，避免打錯字導致同步比對失敗。
  //    先把整張表「所有」既有的資料驗證清掉，再重新套用到目前正確的欄位位置——
  //    這幾天欄位順序改過好幾次，如果不先清空，每次改版只會在新位置多加一條規則，
  //    舊位置的下拉選單永遠不會消失，多個欄位就會疊出好幾代下拉選單。
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  const maxRows = sheet.getMaxRows() - 2;
  sheet.getRange(3, REVIEW_EDITABLE_START_COL, maxRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build()
  );
  const approverNames = center.approverEmails.map(approverDisplayName_);
  if (approverNames.length > 0) {
    sheet.getRange(3, REVIEW_EDITABLE_START_COL + 1, maxRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(approverNames, true).setAllowInvalid(false).build()
    );
  }
  // 「單據完備」的勾選框在 Sheets 底層也是靠資料驗證實作的，上面那行清空資料驗證會連它一起清掉，
  // 儲存格裡的 true/false 值不會不見，只是顯示樣式變回純文字——這裡補回勾選框樣式。
  //
  // ⚠️ 這裡故意「只對目前真的有資料的列」補樣式（sheet.getLastRow()），不是對整個 maxRows（近千列）套用。
  // 這個系統踩過這個坑，教訓是：checkbox 類型的 setDataValidation 只要套用在一大段範圍上，
  // 空白儲存格也會被 Sheets 當成「有內容」，讓 appendRow() 誤判、把新資料擠到最後一列後面。
  // 同一種手法用在「審核狀態」「審核人」的清單式下拉選單上完全沒事，只有 checkbox 類型會這樣，
  // 差別在於 Sheets 對「checkbox 儲存格」的內部表示方式跟一般清單驗證不同。
  // 之後每寫入一筆新資料，checkbox 樣式一律交給 setCompleteCheckbox_（逐列個別設定），不要再改回整欄套用。
  const completeLastRow = sheet.getLastRow();
  if (completeLastRow >= 3) {
    sheet.getRange(3, REVIEW_COMPLETE_COL, completeLastRow - 2, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireCheckbox().build()
    );
  }

  // 4. 裝一個「安裝式觸發條件」在這份審核表上，主管一按下「已退回」立刻通知申請人（見 onReviewStatusEdit_）。
  //    這是獨立於每天的總表同步之外的機制——退件通知要即時，不代表總表同步也要改成即時，兩件事分開處理。
  ensureReviewEditTrigger_(ss);
}

// 盤點「有這份審核表編輯權、但不在中心設定審核人名單上」的人。
//
// 為什麼只回報、不自動移除：applyCenterPermissions_ 只會 addEditor，從來不會 removeEditor，
// 所以把某個人從「中心設定」刪掉、再跑一次這個選單，他的名字雖然會從「審核人」下拉裡消失，
// 編輯權卻還在——他照樣打得開審核表、照樣能改審核三欄。這是實際存在的漏洞（離職、調中心時尤其要注意）。
// 但也不能反過來自動踢人：你可能刻意手動把表分享給會計、稽核或其他不該出現在審核人名單裡的人，
// 自動移除會在你毫無察覺的情況下把他們踢掉。所以這裡只負責「講出來」，要不要處理由人決定。
function strayEditorsOfCenter_(ss, center) {
  const approvers = {};
  center.approverEmails.forEach(function (e) { approvers[e.toLowerCase()] = true; });
  let ownerEmail = '';
  try {
    const owner = ss.getOwner();
    if (owner) ownerEmail = owner.getEmail().toLowerCase();
  } catch (e) {
    // 共用雲端硬碟上的檔案沒有單一擁有者，getOwner() 會失敗；沒有擁有者可以排除也不影響盤點
  }
  const stray = [];
  try {
    ss.getEditors().forEach(function (user) {
      const email = user.getEmail();
      const key = email.toLowerCase();
      if (key === ownerEmail || approvers[key]) return;
      stray.push(email);
    });
  } catch (e) {
    console.error('盤點 ' + center.name + ' 審核表編輯者失敗（不影響其他功能）：' + e);
  }
  return stray;
}

// 確保每份審核表都裝了退件即時通知的觸發條件，重複執行這個選單不會裝出好幾個重複的。
function ensureReviewEditTrigger_(ss) {
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onReviewStatusEdit_' && t.getTriggerSourceId() === ss.getId();
  });
  if (already) return;
  ScriptApp.newTrigger('onReviewStatusEdit_').forSpreadsheet(ss).onEdit().create();
}

function appendToCenterReviewSheet_(record, fileUrl) {
  const project = findProject_(record.project);
  if (!project) {
    // 專案不在「專案設定」裡：不要沉默失敗，明確記錄下來，方便從執行紀錄查到
    throw new Error('專案「' + record.project + '」不在「' + PROJECTS_SHEET_NAME + '」分頁中，未建立審核列');
  }
  if (project.status === PROJECT_STATUS_ENDED) {
    throw new Error('專案「' + record.project + '」已標記為已結束，未建立審核列');
  }
  const center = findCenter_(project.center);
  if (!center) {
    throw new Error('專案「' + record.project + '」設定的所屬中心「' + project.center + '」不在「' + CENTERS_SHEET_NAME + '」分頁中，未建立審核列');
  }
  if (center.status === PROJECT_STATUS_ENDED) {
    throw new Error('中心「' + center.name + '」已標記為已結束，未建立審核列');
  }
  const ss = getOrCreateCenterSpreadsheet_(center);
  const sheet = getReviewSheet_(ss);
  // 欄位順序必須跟 REVIEW_HEADERS 完全一致（見上方常數區）。改這裡一定要跟著改 REVIEW_HEADERS，並跑驗證腳本。
  sheet.appendRow([
    formatDateTime_(record.uploadedAt), record.uploader, record.project, record.docType || '發票', record.invoiceDate,
    record.amount, record.quoteTotal || '', record.items, record.vendor, record.purpose, record.budgetItem || '',
    record.payStatus || '', record.payMethod || '', record.repayTarget || '', record.payee || '', record.paymentDetail || '', record.cardConfirmNote || '',
    record.urgent ? '緊急' : '一般', record.expectedPayoutDate || '', record.linkedQuoteId || '', fileUrl,
    '待審核', '', '', '', '', record.id,
  ]);
  setCompleteCheckbox_(sheet, sheet.getLastRow(), REVIEW_COMPLETE_COL); // 只對剛寫入的這一列設勾選框
}

/* ============================================================
   同步：審核結果（審核表→總表）＋ 付款日期（總表→審核表）
   ============================================================ */
// 把一列總表的原始資料，轉成 appendToCenterReviewSheet_ 需要的「record」物件形狀，
// 給 backfillMissingReviewRows_ 補寫審核列用——那個函式平常吃的是網頁送來的 record，
// 這裡是從已經存在總表裡的資料反推回去，欄位名稱要對得上。
// uploadedAt 這裡給的是總表存的「yyyy-MM-dd HH:mm」文字，appendToCenterReviewSheet_
// 內部會再用 formatDateTime_() 包一次、用 new Date() 去解析——V8 認得這個格式，沒問題。
function recordFromMasterRow_(row) {
  return {
    id: row[MASTER_RECORD_ID_COL - 1],
    uploadedAt: row[MASTER_UPLOAD_TIME_COL - 1],
    uploader: row[MASTER_UPLOADER_COL - 1],
    project: row[MASTER_PROJECT_COL - 1],
    docType: row[MASTER_DOCTYPE_COL - 1] || '發票',
    invoiceDate: formatDateOnly_(row[MASTER_INVOICE_DATE_COL - 1]),
    amount: row[MASTER_AMOUNT_COL - 1],
    quoteTotal: row[MASTER_QUOTE_TOTAL_COL - 1],
    items: row[MASTER_ITEMS_COL - 1],
    vendor: row[MASTER_VENDOR_COL - 1],
    purpose: row[MASTER_PURPOSE_COL - 1],
    budgetItem: row[MASTER_BUDGET_ITEM_COL - 1],
    payStatus: row[MASTER_PAYSTATUS_COL - 1],
    payMethod: row[MASTER_PAYMETHOD_COL - 1],
    repayTarget: row[MASTER_REPAY_TARGET_COL - 1],
    payee: row[MASTER_PAYEE_COL - 1],
    paymentDetail: row[MASTER_PAYINFO_COL - 1],
    cardConfirmNote: row[MASTER_CARD_CONFIRM_COL - 1],
    linkedQuoteId: row[MASTER_LINKED_QUOTE_COL - 1],
    urgent: row[MASTER_URGENCY_COL - 1] === '緊急',
    expectedPayoutDate: formatDateOnly_(row[MASTER_EXPECTED_PAYOUT_COL - 1]),
  };
}

// 補齊「總表有、但該去的中心審核表卻沒有」的列。
//
// 為什麼會發生：createRow_ 寫完總表後，會另外呼叫 appendToCenterReviewSheet_ 寫進審核表，
// 但那段是包在 try/catch 裡、失敗只會寫進 Apps Script 的執行紀錄，不會讓整個請求失敗
// （設計上是刻意的：總表才是最重要的那份，不能因為審核表那邊出狀況就連總表都寫不進去）。
// 代價是這個失敗前端完全看不到、使用者也不知道要去哪裡補——真實發生過：組織發展中心少了
// 好幾筆，總表卻是完整的，按「立即同步審核結果」也沒用（那個函式原本只更新「已經在審核表
// 裡的列」，不會幫忙補上「總表有、審核表沒有」的列）。這裡就是專門補這個洞。
function backfillMissingReviewRows_() {
  const master = getSheet_();
  const lastRow = master.getLastRow();
  if (lastRow < 3) return 0;
  const all = master.getRange(3, 1, lastRow - 2, HEADERS.length).getValues();

  // 每個中心審核表目前已經有哪些紀錄ID，先收集起來，才知道總表裡哪些列是漏掉的
  const existingIdsByCenter = {};
  loadConfig_().centers.forEach(function (center) {
    if (!center.reviewSheetId) return;
    try {
      const sheet = getReviewSheet_(SpreadsheetApp.openById(center.reviewSheetId));
      const rLast = sheet.getLastRow();
      const ids = rLast >= 3
        ? sheet.getRange(3, REVIEW_RECORD_ID_COL, rLast - 2, 1).getValues().map(function (r) { return r[0]; })
        : [];
      existingIdsByCenter[center.name] = new Set(ids);
    } catch (e) {
      console.error('讀取 ' + center.name + ' 審核表既有紀錄失敗（略過補齊這個中心）：' + e);
    }
  });

  let backfilled = 0;
  all.forEach(function (row) {
    const id = row[MASTER_RECORD_ID_COL - 1];
    if (!id) return;
    const project = findProject_(row[MASTER_PROJECT_COL - 1]);
    if (!project || project.status === PROJECT_STATUS_ENDED) return; // 已結束的略過，跟 appendToCenterReviewSheet_ 邏輯一致
    const center = findCenter_(project.center);
    if (!center || center.status === PROJECT_STATUS_ENDED) return;
    const idSet = existingIdsByCenter[center.name];
    if (!idSet || idSet.has(id)) return; // 這個中心讀取失敗、或這筆本來就已經在審核表裡了
    try {
      appendToCenterReviewSheet_(recordFromMasterRow_(row), row[MASTER_FILE_URL_COL - 1]);
      idSet.add(id); // 同一次執行內記得補過了，避免萬一資料有重複紀錄ID時補兩次
      backfilled++;
    } catch (err) {
      console.error('補齊審核表列失敗（紀錄ID ' + id + '）：' + err);
    }
  });
  return backfilled;
}

function syncApprovalsToMaster() {
  const backfilled = backfillMissingReviewRows_();
  const master = getSheet_();
  const lastRow = master.getLastRow();
  if (lastRow < 3) return { updated: 0, backfilled: backfilled }; // 第 1 列標註、第 2 列標題，資料從第 3 列開始

  const all = master.getRange(3, 1, lastRow - 2, HEADERS.length).getValues();
  const rowById = {};
  all.forEach(function (row, i) {
    const id = row[MASTER_RECORD_ID_COL - 1];
    if (id) rowById[id] = i + 3;
  });

  let updated = 0;

  loadConfig_().centers.forEach(function (center) {
    if (!center.reviewSheetId) return;
    let sheet;
    try {
      sheet = getReviewSheet_(SpreadsheetApp.openById(center.reviewSheetId));
    } catch (e) {
      console.error('開啟 ' + center.name + ' 審核表失敗：' + e);
      return;
    }
    const rLast = sheet.getLastRow();
    if (rLast < 3) return;
    const rows = sheet.getRange(3, 1, rLast - 2, REVIEW_HEADERS.length).getValues();

    rows.forEach(function (row, idx) {
      const recordId = row[REVIEW_RECORD_ID_COL - 1];
      if (!recordId) return;
      const masterRow = rowById[recordId];
      if (!masterRow) return;
      const masterData = all[masterRow - 3];

      // (A) 審核結果：審核表 → 總表
      const status = row[REVIEW_EDITABLE_START_COL - 1];
      const reviewer = row[REVIEW_REVIEWER_COL - 1];
      const note = row[REVIEW_NOTE_COL - 1];
      const statusChanged = status && status !== '待審核' &&
        (masterData[MASTER_STATUS_COL - 1] !== status ||
         masterData[MASTER_REVIEWER_COL - 1] !== reviewer ||
         masterData[MASTER_REJECT_REASON_COL - 1] !== note);

      if (statusChanged) {
        master.getRange(masterRow, MASTER_STATUS_COL, 1, 4).setValues([[
          status, reviewer, formatDateTime_(new Date().toISOString()), note,
        ]]);
        updated++;

        // 退回的憑證搬到「已退回」資料夾；改判核准則搬回原本的專案/年月資料夾。
        // 檔案永遠只搬移不刪除，保留稽核軌跡；搬檔失敗不影響狀態同步。
        try {
          const fileUrl = masterData[MASTER_FILE_URL_COL - 1];
          if (status === '已退回') {
            moveReceiptFile_(fileUrl, getRejectedFolder_());
          } else if (status === '已核准') {
            moveReceiptFile_(fileUrl, getMonthFolder_(masterData[MASTER_PROJECT_COL - 1], masterData[MASTER_PERIOD_COL - 1]));
          }
        } catch (err) {
          console.error('搬移憑證失敗（不影響審核狀態同步）：' + err);
        }
      }

      // (B) 單據完備：總表 → 審核表（後勤人員在總表勾選，主管在審核表看得到）
      const masterComplete = masterData[MASTER_COMPLETE_COL - 1] === true;
      const reviewComplete = row[REVIEW_COMPLETE_COL - 1] === true;
      if (masterComplete !== reviewComplete) {
        sheet.getRange(idx + 3, REVIEW_COMPLETE_COL).setValue(masterComplete);
        updated++;
      }

      // (C) 付款日期：總表 → 審核表（財務在總表填，主管在審核表看得到）
      const masterPaid = formatDateOnly_(masterData[MASTER_PAYDATE_COL - 1]);
      const reviewPaid = formatDateOnly_(row[REVIEW_PAYDATE_COL - 1]);
      if (masterPaid && masterPaid !== reviewPaid) {
        sheet.getRange(idx + 3, REVIEW_PAYDATE_COL).setValue(masterPaid);
        updated++;
      }
    });
  });
  return { updated: updated, backfilled: backfilled };
}

function syncApprovalsNow() {
  const result = syncApprovalsToMaster();
  // 「更新 N 個欄位」算的是欄位數不是單據筆數（同一筆單據的審核結果、單據完備、付款日期
  // 如果一起變動，會各算一次）；「補齊 N 列」是總表有、但審核表原本沒有的列，這次自動補上了。
  const backfillNote = result.backfilled > 0
    ? '\n\n⚠️ 另外發現 ' + result.backfilled + ' 筆總表有、但審核表原本沒有的紀錄，已自動補上（可能是先前寫入審核表時失敗留下的缺漏）。'
    : '';
  SpreadsheetApp.getUi().alert('同步完成，共更新 ' + result.updated + ' 個欄位（審核結果、單據完備、付款日期）。' + backfillNote);
}

// 從 Drive 檔案網址取出檔案 ID（getUrl() 會回傳 .../file/d/{id}/view 這種格式）
function fileIdFromUrl_(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

function moveReceiptFile_(fileUrl, targetFolder) {
  const id = fileIdFromUrl_(fileUrl);
  if (!id) return;
  const file = DriveApp.getFileById(id);
  // 已經在目標資料夾就不用重複搬（同步每天都會跑，避免多做事）
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === targetFolder.getId()) return;
  }
  file.moveTo(targetFolder);
}

/* ============================================================
   Slack 通知
   ============================================================ */
function postToSlack_(text) {
  if (!SLACK_WEBHOOK_URL) return;
  UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
}

// 審核人、審核表現在都設在「中心」層級，這些函式的參數還是專案名稱（呼叫端都是拿 record.project 來用），
// 所以先查這個專案屬於哪個中心，再去查中心的審核人／審核表——呼叫端完全不用改。
function centerOfProject_(projectName) {
  const project = findProject_(projectName);
  return project ? findCenter_(project.center) : null;
}

// 真正會 tag 到人、讓對方跳通知的版本，只用在「緊急」單據。
// 一般彙總刻意不用這個，避免例行提醒打擾審核人。
function projectApproverPingText_(projectName) {
  const center = centerOfProject_(projectName);
  if (!center || center.approverEmails.length === 0) return '（未設定審核人）';
  return center.approverEmails.map(function (email) {
    const person = personByEmail_(email);
    return (person && person.slackId) ? '<@' + person.slackId + '>'
      : approverDisplayName_(email) + '（尚未設定 Slack ID，不會跳通知）';
  }).join(' ');
}

function reviewSheetUrl_(projectName) {
  const center = centerOfProject_(projectName);
  if (!center || !center.reviewSheetId) return '';
  try {
    return SpreadsheetApp.openById(center.reviewSheetId).getUrl();
  } catch (e) {
    return '';
  }
}

function notifyUrgentToSlack_(record, fileUrl) {
  const url = reviewSheetUrl_(record.project);
  const lines = [
    '🚨 *有一筆緊急單據待審核*　' + projectApproverPingText_(record.project),
    '專案：' + record.project,
    '上傳者：' + record.uploader,
    '金額：NT$ ' + (record.amount || 0),
    '用途：' + (record.purpose || record.items || '—'),
    fileUrl ? '憑證：' + fileUrl : '',
    url ? '前往審核：' + url : '',
  ];
  postToSlack_(lines.filter(Boolean).join('\n'));
}

const REJECT_NOTIFY_DELAY_MS = 60000; // 給審核人一點時間把「審核備註」的退回原因打完，見下方說明

// 安裝式觸發條件的進入點（由 ensureReviewEditTrigger_ 裝在每份審核表上，主管編輯時自動執行）。
// 只在「審核狀態」欄被改成「已退回」的當下觸發，即時通知申請人、帶上退回原因——
// 跟總表的每日同步是分開的兩件事，這裡不管總表有沒有同步到，一被退回就會發。
// 刻意只做這一件事：不處理同一筆多次退回的疊加/彙整，也不做逾期未補件的二次提醒（範圍外，日後再議）。
function onReviewStatusEdit_(e) {
  try {
    if (!e || !e.range) return;
    const range = e.range;
    if (range.getSheet().getName() !== REVIEW_SHEET_NAME) return;
    if (range.getColumn() !== REVIEW_EDITABLE_START_COL || range.getNumColumns() !== 1 || range.getNumRows() !== 1) return;
    if (range.getRow() < 3) return; // 第 1 列標註、第 2 列標題，不會是真正的資料列
    if (range.getValue() !== '已退回') return;

    const sheet = range.getSheet();
    const row = range.getRow();

    // 使用習慣通常是先把「審核狀態」改成已退回，才回頭在旁邊的「審核備註」打退回原因——
    // 這裡的觸發點只在狀態欄被改動的當下，如果立刻讀取，原因欄多半還是空的。
    // 所以刻意先在背景等一小段時間（不會卡住試算表畫面，審核人可以照常繼續打字），
    // 再讀取當下最新的原因內容一起送出。
    //
    // 這裡故意不用「建立一個延後執行的一次性觸發條件」這種更精準的做法：Apps Script
    // 每個專案最多只有 20 個觸發條件，一次性觸發條件要靠程式自己在執行完後刪除，
    // 萬一哪次刪除失敗（執行中斷、程式出錯），觸發條件會越堆越多，一旦爆表會讓包括
    // 每日審核同步在內的所有排程整個失效，而且不會有任何警示。用 sleep 換取「絕對不會
    // 多佔用任何觸發條件額度」，代價是如果審核人打退回原因花超過這段等待時間，
    // 這次通知還是會用讀取當下的內容送出（可能還是空的）。
    Utilities.sleep(REJECT_NOTIFY_DELAY_MS);

    const rowData = sheet.getRange(row, 1, 1, REVIEW_HEADERS.length).getValues()[0];
    const uploader = rowData[REVIEW_UPLOADER_COL - 1];
    const projectName = rowData[REVIEW_PROJECT_COL - 1] || '（未知專案）'; // 現在一份審核表裝多個專案，專案名稱直接讀這一列自己的「所屬專案」欄，不用再反查是哪份試算表
    const invoiceDate = formatDateOnly_(rowData[REVIEW_INVOICE_DATE_COL - 1]); // 同一個老問題：欄位有時被 Sheets 自動轉成真正的日期物件，直接印會變成一長串英文
    const amount = rowData[REVIEW_AMOUNT_COL - 1];
    const items = rowData[REVIEW_ITEMS_COL - 1];
    const vendor = rowData[REVIEW_VENDOR_COL - 1];
    const rejectReason = rowData[REVIEW_NOTE_COL - 1] || '（審核人未填寫原因）';

    const person = personByName_(uploader);
    const mention = (person && person.slackId) ? '<@' + person.slackId + '>' : (uploader || '（未知申請人）') + '（尚未設定 Slack ID，不會跳通知）';

    const lines = [
      '↩️ *您的單據被退回，請補件後重新上傳*　' + mention,
      '專案：' + projectName,
      '發票日期：' + (invoiceDate || '—') + '　金額：NT$ ' + (amount || 0),
      '內容：' + (items || vendor || '—'),
      '退回原因：' + rejectReason,
    ];
    postToSlack_(lines.join('\n'));
  } catch (err) {
    console.error('退件即時通知失敗：' + err);
  }
}

// 每月固定的審核日提醒：不管有沒有待審項目，一律用 <!channel> 發一句提醒 + 各中心審核表連結
// （審核表現在一個中心一份，列中心而不是列專案，不然同中心底下的專案會重複列出同一個連結）
function sendPendingDigestToSlack() {
  const lines = ['📋 <!channel> 今天是各位主管的審核日，請記得審核喔！', ''];
  activeCenters_().forEach(function (center) {
    const url = center.reviewSheetId ? (function () {
      try { return SpreadsheetApp.openById(center.reviewSheetId).getUrl(); } catch (e) { return ''; }
    })() : '';
    lines.push('• ' + center.name + (url ? ' → ' + url : '（尚未建立審核表，先執行選單「① 建立/更新設定與審核表」）'));
  });
  postToSlack_(lines.join('\n'));
}

/**
 * 付款完成通知（手動觸發）。
 * 因為會計是排班制、不一定在固定日子上班，所以不用排程，改由會計在總表填完付款日期後，
 * 從選單自己按一次「立即發送付款通知到 Slack」即可。
 * 統計範圍是「付款日期落在本月」的所有紀錄。
 */
function sendPaymentDigestToSlack() {
  const master = getSheet_();
  const lastRow = master.getLastRow();
  const ui = SpreadsheetApp.getUi();
  if (lastRow < 3) { // 第 1 列標註、第 2 列標題，資料從第 3 列開始
    ui.alert('目前總表沒有任何資料。');
    return;
  }

  const values = master.getRange(3, 1, lastRow - 2, HEADERS.length).getValues();
  const thisMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const byProject = {};
  let total = 0;
  let totalAmount = 0;

  values.forEach(function (row) {
    const paid = formatDateOnly_(row[MASTER_PAYDATE_COL - 1]);
    if (!paid || paid.slice(0, 7) !== thisMonth) return;
    const project = row[MASTER_PROJECT_COL - 1] || '（未指定專案）';
    if (!byProject[project]) byProject[project] = { count: 0, amount: 0 };
    byProject[project].count++;
    const amount = Number(row[MASTER_AMOUNT_COL - 1]) || 0;
    byProject[project].amount += amount;
    total++;
    totalAmount += amount;
  });

  if (total === 0) {
    ui.alert('本月（' + thisMonth + '）還沒有任何已填付款日期的紀錄，未發送通知。');
    return;
  }

  const lines = ['💰 <!channel> 本月（' + thisMonth + '）已完成付款 ' + total + ' 筆，合計 NT$ ' + totalAmount.toLocaleString('en-US'), ''];
  Object.keys(byProject).forEach(function (project) {
    lines.push('• ' + project + '：' + byProject[project].count + ' 筆，NT$ ' + byProject[project].amount.toLocaleString('en-US'));
  });
  lines.push('', '款項已匯出，明細可查看各中心審核表的「付款日期」欄。');
  postToSlack_(lines.join('\n'));

  ui.alert('已發送付款通知：本月共 ' + total + ' 筆，合計 NT$ ' + totalAmount.toLocaleString('en-US') + '。');
}

/* ============================================================
   排程與選單
   ============================================================ */
function setupTriggers() {
  // 先清掉舊的，避免重複安裝造成一次跑很多遍
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'syncApprovalsToMaster' || fn === 'sendPendingDigestToSlack' || fn === 'sendScheduledDigestIfDue_') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 每天固定時間同步一次即可（審核集中在每月固定幾天，急件用選單「立即同步審核結果」手動處理）
  ScriptApp.newTrigger('syncApprovalsToMaster').timeBased().everyDays(1).atHour(23).create();
  // 每天檢查一次是不是「本月審核日」（含週末順延），而不是直接用 onMonthDay
  ScriptApp.newTrigger('sendScheduledDigestIfDue_').timeBased().everyDays(1).atHour(10).create();

  SpreadsheetApp.getUi().alert(
    '已設定自動排程：\n\n' +
    '• 每天晚上 11 點左右同步審核結果與付款日期（Apps Script 只能指定「幾點」，不保證精確到分鐘）\n' +
    '• 每月 ' + DIGEST_DAY_OF_MONTH + ' 號上午 10 點發送審核提醒到 Slack（@channel；遇週末自動順延到下一個週一）\n\n' +
    '付款通知沒有排程，請會計填完付款日期後，從選單按「立即發送付款通知到 Slack」。'
  );
}

// 排程專用：每天執行，只有輪到「本月審核日」（已考慮週末順延）才真的發送
function sendScheduledDigestIfDue_() {
  if (isReviewReminderDay_()) sendPendingDigestToSlack();
}

function isReviewReminderDay_() {
  const tz = 'Asia/Taipei';
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth(), DIGEST_DAY_OF_MONTH);
  const weekday = target.getDay(); // 0=週日, 6=週六
  if (weekday === 6) target.setDate(target.getDate() + 2); // 六 → 順延到週一
  if (weekday === 0) target.setDate(target.getDate() + 1); // 日 → 順延到週一
  return Utilities.formatDate(today, tz, 'yyyy-MM-dd') === Utilities.formatDate(target, tz, 'yyyy-MM-dd');
}

function onOpen() {
  // onOpen 只會在總表本身被打開時觸發，這是最不會弄錯的時機，順便把總表 ID 快取起來
  // （見 getMasterSpreadsheet_），讓審核表上的觸發條件之後執行時能直接拿到，不用等它自己去猜。
  try {
    PropertiesService.getScriptProperties().setProperty(MASTER_SPREADSHEET_ID_PROP_, SpreadsheetApp.getActiveSpreadsheet().getId());
  } catch (e) {
    // 簡單觸發條件的權限較受限，這裡失敗也不影響選單顯示；之後跑選單時 getMasterSpreadsheet_() 還是會自己補上快取
  }
  SpreadsheetApp.getUi()
    .createMenu('核銷小幫手')
    .addItem('① 建立/更新設定與審核表', 'setupProjectReviewSheets')
    .addItem('② 設定自動排程', 'setupTriggers')
    .addSeparator()
    .addItem('立即同步審核結果 / 付款日期', 'syncApprovalsNow')
    .addItem('立即發送待審提醒到 Slack', 'sendPendingDigestToSlack')
    .addItem('💰 立即發送付款通知到 Slack', 'sendPaymentDigestToSlack')
    .addToUi();
}

/**
 * 授權用測試函式。設定好 GEMINI_API_KEY 後，在編輯器上方的函式下拉選單選「testGeminiAuth」
 * 並按「執行」，Google 會跳出授權畫面（要允許「連線至外部服務」這項權限）。
 *
 * 注意：函式名稱結尾「不能」有底線，否則 Apps Script 會視為私有函式而不顯示在下拉選單中。
 */
function testGeminiAuth() {
  var tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  Logger.log(JSON.stringify(recognizeReceipt_(tinyImage)));
}

/**
 * 授權用測試函式（同上，函式名稱結尾不能有底線）。用來確認目前登入的帳號對
 * DRIVE_FOLDER_ID 這個資料夾真的有存取權，並觸發 Drive 服務的授權畫面。
 * 執行完看「執行項目」或這裡的記錄，應該會印出資料夾名稱；如果噴錯，錯誤訊息會直接告訴你是授權問題還是 ID 錯誤。
 */
function testDriveAuth() {
  if (!DRIVE_FOLDER_ID) {
    Logger.log('DRIVE_FOLDER_ID 是空的，會改用「我的雲端硬碟」自動建立資料夾，不需要測試這個。');
    return;
  }
  var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  Logger.log('成功存取資料夾：' + folder.getName() + '（' + folder.getUrl() + '）');
}
