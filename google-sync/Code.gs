/**
 * Skills for U｜核銷小幫手 — Google Sheets / Drive 同步 + 專案審核 + Slack 通知
 *
 * ── 第一次設定 ─────────────────────────────────────────────
 * 1. 開一個 Google 試算表（這份就是「總表」），選單「擴充功能」→「Apps Script」，把這個檔案整份貼進去。
 * 2. 修改下面「機密設定區」：SECRET_TOKEN、GEMINI_API_KEY、SLACK_WEBHOOK_URL。
 * 3. 右上角「部署」→「新增部署作業」→「網頁應用程式」：執行身分「我」、誰可以存取「任何人」。
 *    把拿到的 /exec 網址跟 SECRET_TOKEN 貼到「核銷小幫手」網頁的「雲端同步設定」。
 * 4. 重新整理總表，上方會多一個「核銷小幫手」選單，點「① 建立/更新設定與審核表」。
 *    這會建立「人員設定」「專案設定」兩個分頁（第一次會用下面的種子名單預填），
 *    並依「專案設定」幫每個進行中的專案建立獨立審核試算表、設好權限、分享給審核人。
 * 5. 點「② 設定自動排程」安裝定時任務。
 *
 * ── 之後要異動人員或專案，不用再改程式碼 ──────────────────
 * 直接編輯總表的「人員設定」「專案設定」分頁即可，改完再點一次「① 建立/更新設定與審核表」。
 * 專案結束就把「狀態」改成「已結束」：上傳選單不再出現、Slack 提醒會跳過，
 * 但審核表與歷史資料都保留（稽核用），不會被刪除。
 *
 * ── 權限模型 ───────────────────────────────────────────────
 * 每個專案有自己獨立的試算表，只分享給該專案的審核人（編輯者）。
 * 表內除了「審核狀態／審核人／審核備註」三欄之外全部鎖定，
 * 所以審核人只能改審核結果，不能竄改單據原始資料或付款日期。
 *
 * ── 安全性提醒 ─────────────────────────────────────────────
 * 網頁應用程式設成「任何人」可存取，代表拿到網址 + SECRET_TOKEN 就能寫資料進來。
 * 請勿公開分享網址與密碼；外流時改一組新的 SECRET_TOKEN 並重新部署即可失效舊的存取權。
 * GEMINI_API_KEY 與 SLACK_WEBHOOK_URL 同樣是機密，不要外流。
 */

/* ============================================================
   機密設定區（只有這裡需要改程式碼）
   ============================================================ */
const SHEET_NAME = '收支總表';     // 總表裡要寫入的分頁名稱，找不到會自動建立
const DRIVE_FOLDER_ID = '';        // 留空 = 自動在「我的雲端硬碟」建立「核銷小幫手」資料夾
const SECRET_TOKEN = '請改成你自己的密碼字串';
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
const SEED_PROJECTS = [
  // [專案名稱, 審核人Email（逗號分隔）, 狀態, 憑證資料夾ID]
  ['組織發展中心', 'ceo@skillsforu.org, rosyhu@skillsforu.org', '進行中', ''],
  ['高雄技職年會', 'ceo@skillsforu.org, rein@skillsforu.org', '進行中', ''],
  ['臺灣技職教育年會', 'ceo@skillsforu.org, daphnekuo@skillsforu.org', '進行中', ''],
  ['組織行銷中心', 'ceo@skillsforu.org', '進行中', ''],
  ['人才培育中心', 'ceo@skillsforu.org', '進行中', ''],
];

/* ============================================================
   欄位定義
   ============================================================ */
// 總表欄位順序。調整時 createRow_ 的寫入順序與下面的欄位位置常數要一起改。
const HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '發票日期', '金額', '單據內容', '公司名稱', '用途', '預算項目',
  '所屬期間', '付款方式', '收款對象', '付款資訊', '信用卡紙本確認', '急迫性', '期望撥款日期',
  '狀態', '審核人', '審核時間', '退回原因', '單據完備', '付款日期', '憑證檔名', '憑證雲端連結',
  '紀錄ID',
];
const MASTER_PROJECT_COL = 3;
const MASTER_PERIOD_COL = 10;
const MASTER_STATUS_COL = 17;    // 狀態、審核人、審核時間、退回原因＝第 17~20 欄（四欄連續）
const MASTER_COMPLETE_COL = 21;  // 單據完備，由後勤人員手動勾選，放在付款日期前面
const MASTER_PAYDATE_COL = 22;   // 付款日期，由財務手動填，會同步到各專案審核表
const MASTER_FILE_URL_COL = 24;  // 憑證雲端連結，退回時要靠它找到檔案搬到「已退回」資料夾
const MASTER_RECORD_ID_COL = 25;

// 各專案審核表的欄位。除了「審核狀態／審核人／審核備註」三欄，其餘都鎖定唯讀。
const REVIEW_HEADERS = [
  '上傳時間', '上傳者', '發票日期', '金額', '單據內容', '公司名稱', '用途', '預算項目',
  '付款方式', '收款對象', '付款資訊', '信用卡紙本確認', '急迫性', '期望撥款日期', '憑證連結',
  '審核狀態', '審核人', '審核備註', '單據完備', '付款日期', '紀錄ID',
];
const REVIEW_EDITABLE_START_COL = 16; // 審核狀態
const REVIEW_EDITABLE_COL_COUNT = 3;  // 審核狀態、審核人、審核備註
const REVIEW_COMPLETE_COL = 19;       // 單據完備，由總表同步過來（後勤在總表勾選）
const REVIEW_PAYDATE_COL = 20;        // 由總表同步過來，審核人不能改
const REVIEW_RECORD_ID_COL = 21;

const PEOPLE_SHEET_NAME = '人員設定';
const PROJECTS_SHEET_NAME = '專案設定';
const BUDGET_SHEET_NAME = '預算項目設定';
const PEOPLE_HEADERS = ['姓名', 'Email', 'Slack個人ID'];
const PROJECTS_HEADERS = ['專案名稱', '審核人Email（逗號分隔）', '狀態', '憑證資料夾ID', '審核表ID（自動產生，勿手動修改）', '審核表連結'];
const BUDGET_HEADERS = ['專案/中心', '預算類別', '預算項目', '對應會計科目'];
// 上傳時真的不知道該歸哪一項時的保底選項，每個專案的下拉都會自動附加這個，
// 不需要在「預算項目設定」分頁裡手動幫每個專案各加一列。
const UNSPECIFIED_BUDGET_ITEM = '不確定預算項目';

const STATUS_OPTIONS = ['待審核', '已核准', '已退回'];
const PROJECT_STATUS_ACTIVE = '進行中';
const PROJECT_STATUS_ENDED = '已結束';

/* ============================================================
   設定分頁讀寫（人員設定 / 專案設定）
   ============================================================ */
let _configCache = null; // 同一次執行內只讀一次，避免重複讀表

function getOrCreateSheet_(name, headers, seedRows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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

  const projects = [];
  const projLast = projectsSheet.getLastRow();
  if (projLast >= 2) {
    projectsSheet.getRange(2, 1, projLast - 1, PROJECTS_HEADERS.length).getValues().forEach(function (r, i) {
      const name = String(r[0] || '').trim();
      if (!name) return;
      projects.push({
        name: name,
        approverEmails: String(r[1] || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean),
        status: String(r[2] || '').trim() || PROJECT_STATUS_ACTIVE,
        folderId: String(r[3] || '').trim(),
        reviewSheetId: String(r[4] || '').trim(),
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

  _configCache = { people: people, projects: projects, projectsSheet: projectsSheet, budgetItemsByProject: budgetItemsByProject };
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
function personByEmail_(email) {
  const list = loadConfig_().people;
  for (let i = 0; i < list.length; i++) if (list[i].email && list[i].email === email) return list[i];
  return null;
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

// 把自動產生的審核表 ID / 連結寫回「專案設定」，之後就靠 ID 找檔案（搬資料夾也不會壞）
function saveProjectReviewSheet_(project, sheetId, url) {
  const cfg = loadConfig_();
  cfg.projectsSheet.getRange(project.rowIndex, 5, 1, 2).setValues([[sheetId, url]]);
  project.reviewSheetId = sheetId;
}

/* ============================================================
   Web App 入口
   ============================================================ */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SECRET_TOKEN) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }
    if (body.action === 'ocr') {
      // imageDataUrls（陣列）＝ PDF 在瀏覽器端轉成的多頁壓縮圖片；沒有的話退回單一張 imageDataUrl
      const images = Array.isArray(body.imageDataUrls) && body.imageDataUrls.length ? body.imageDataUrls : [body.imageDataUrl];
      return jsonOut_(recognizeReceipt_(images));
    }
    if (body.action === 'getConfig') {
      return jsonOut_(getConfigForApp_());
    }
    if (body.action === 'getStatuses') {
      return jsonOut_(getAllStatuses_());
    }
    const sheet = getSheet_();
    if (body.action === 'create') {
      return jsonOut_(createRow_(sheet, body.record));
    }
    if (body.action === 'update') {
      return jsonOut_(updateRow_(sheet, body.record));
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
  return {
    ok: true,
    uploaders: cfg.people.map(function (p) { return p.name; }),
    projects: activeProjects_().map(function (p) { return p.name; }),
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
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = res.getResponseCode();
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
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    // 「發票日期」「所屬期間」存的是我們自訂格式的純文字（YYYY-MM-DD / YYYY-MM），
    // 不先設成純文字格式，Sheets 會自動把它們轉成真正的日期儲存格，
    // 之後程式讀回來就會變成 Date 物件而不是原本的字串（例如資料夾名稱變成一長串英文日期）。
    sheet.getRange(2, 4, sheet.getMaxRows() - 1, 1).setNumberFormat('@');  // 發票日期
    sheet.getRange(2, 10, sheet.getMaxRows() - 1, 1).setNumberFormat('@'); // 所屬期間
    sheet.getRange(2, 16, sheet.getMaxRows() - 1, 1).setNumberFormat('@'); // 期望撥款日期
    sheet.getRange(2, 19, sheet.getMaxRows() - 1, 1).setNumberFormat('@'); // 審核時間
    sheet.getRange(2, 22, sheet.getMaxRows() - 1, 1).setNumberFormat('@'); // 付款日期
    // 「單據完備」勾選框改成「每寫入一列才對那一列設定」（見 createRow_ 的 setCompleteCheckbox_），
    // 不在這裡對整欄一次設定——避免任何指令把 2~1000 列都當成「有資料」，害 appendRow() 把
    // 新資料接到第 1000 列後面而不是第 2 列。
  }
  return sheet;
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

// 依專案找資料夾：「專案設定」有填憑證資料夾ID 就用那個現成資料夾，沒填就在主資料夾底下建同名資料夾
function getProjectFolder_(projectName) {
  const project = findProject_(projectName);
  if (project && project.folderId) return DriveApp.getFolderById(project.folderId);
  return findOrCreateSubfolder_(getRootFolder_(), projectName || '未分類專案');
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
  sheet.appendRow([
    formatDateTime_(record.uploadedAt), record.uploader, record.project, record.invoiceDate,
    record.amount, record.items, record.vendor, record.purpose, record.budgetItem || '', record.period,
    record.payMethod || '', record.payee || '', record.paymentDetail || '', record.cardConfirmNote || '',
    record.urgent ? '緊急' : '一般', record.expectedPayoutDate || '', statusLabel_(record.status),
    record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
    '', // 單據完備，由後勤人員在總表勾選
    '', // 付款日期，等財務付款後手動填
    record.fileName, fileUrl, record.id,
  ]);
  setCompleteCheckbox_(sheet, sheet.getLastRow(), MASTER_COMPLETE_COL); // 只對剛寫入的這一列設勾選框

  // 同步一份到該專案的審核表，供主管審核
  try {
    appendToProjectReviewSheet_(record, fileUrl);
  } catch (err) {
    console.error('寫入專案審核表失敗：' + err);
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
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
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
  if (lastRow < 2) return { ok: true, statuses: {} };
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const statuses = {};
  values.forEach(function (row) {
    const id = row[MASTER_RECORD_ID_COL - 1];
    if (!id) return;
    statuses[id] = {
      status: row[MASTER_STATUS_COL - 1],
      reviewer: row[MASTER_STATUS_COL],
      reviewedAt: formatDateTime_(row[MASTER_STATUS_COL + 1]), // Date 安全：formatDateTime_ 對 Date 物件跟文字都能正確處理
      rejectReason: row[MASTER_STATUS_COL + 2],
      receiptComplete: row[MASTER_COMPLETE_COL - 1] === true || row[MASTER_COMPLETE_COL - 1] === '是' || row[MASTER_COMPLETE_COL - 1] === 'TRUE',
      paidAt: formatDateOnly_(row[MASTER_PAYDATE_COL - 1]),
    };
  });
  return { ok: true, statuses: statuses };
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
  const created = [];
  const skipped = [];
  activeProjects_().forEach(function (project) {
    const ss = getOrCreateProjectSpreadsheet_(project);
    applyProjectPermissions_(ss, project);
    created.push(project.name);
  });
  loadConfig_().projects.forEach(function (p) {
    if (p.status === PROJECT_STATUS_ENDED) skipped.push(p.name);
  });

  SpreadsheetApp.getUi().alert(
    '設定分頁與審核表已更新。\n\n' +
    '進行中專案（' + created.length + '）：\n' + (created.join('\n') || '（無）') +
    '\n\n已結束、略過的專案（' + skipped.length + '）：\n' + (skipped.join('\n') || '（無）') +
    '\n\n各審核表的網址可在「' + PROJECTS_SHEET_NAME + '」分頁查看，已自動分享給對應的審核人。\n' +
    '要異動人員或專案，直接編輯「' + PEOPLE_SHEET_NAME + '」「' + PROJECTS_SHEET_NAME + '」分頁後再執行一次這個選單即可。'
  );
}

// 標題列、凍結、日期欄純文字格式——不管是「全新建立」還是「既有但被清空」的審核表都要補上，
// 兩種情況共用同一段邏輯，避免像這次一樣：總表有這道防線、審核表卻漏掉，
// 有人手動清空審核表內容（連標題一起刪）之後，系統就再也長不出標題列。
function setupReviewSheetHeaders_(sheet) {
  sheet.appendRow(REVIEW_HEADERS);
  sheet.setFrozenRows(1);
  // 避免「發票日期」「期望撥款日期」「付款日期」被 Sheets 自動轉成真正的日期儲存格
  sheet.getRange(2, 3, sheet.getMaxRows() - 1, 1).setNumberFormat('@');  // 發票日期
  sheet.getRange(2, 14, sheet.getMaxRows() - 1, 1).setNumberFormat('@'); // 期望撥款日期
  sheet.getRange(2, 20, sheet.getMaxRows() - 1, 1).setNumberFormat('@'); // 付款日期
  // 單據完備勾選框改成每寫入一列才對那列設定（見 appendToProjectReviewSheet_），不在這裡對整欄一次設定。
}

function getOrCreateProjectSpreadsheet_(project) {
  if (project.reviewSheetId) {
    try {
      const existing = SpreadsheetApp.openById(project.reviewSheetId);
      // openById 對「已丟進垃圾桶」的檔案不會報錯，還是打得開——如果不特別檢查，
      // 系統會誤以為審核表還在，繼續往垃圾桶裡的舊檔案寫資料，新的完全不會出現在該出現的資料夾。
      // 這裡刻意不自動重建：垃圾桶裡的檔案 30 天內都還在，可能是誤刪，貿然重建
      // 會讓新舊兩份同時存在，之後有人把舊的救回來反而搞不清楚哪份才是正本。
      // 明確報錯，把「救回來」還是「清空這格讓它重建」的決定交給人來下。
      if (DriveApp.getFileById(project.reviewSheetId).isTrashed()) {
        throw new Error(
          '專案「' + project.name + '」的審核表（ID: ' + project.reviewSheetId + '）目前在垃圾桶裡，' +
          '未自動重建。請到 Google 雲端硬碟垃圾桶把它復原，或是把「' + PROJECTS_SHEET_NAME +
          '」分頁裡這個專案的「審核表ID」「審核表連結」兩欄清空後再重新執行這個選單，讓系統建立全新的審核表。'
        );
      }
      const existingSheet = existing.getSheets()[0];
      // 有人手動把整份審核表的內容清空（連標題列一起刪）時，補回標題，跟總表 getSheet_() 是同一個防線。
      if (existingSheet.getLastRow() === 0) setupReviewSheetHeaders_(existingSheet);
      return existing;
    } catch (e) {
      if (String(e).indexOf('目前在垃圾桶裡') !== -1) throw e; // 上面主動拋出的錯誤要讓它往外傳，不能被下面的 catch 吞掉
      // openById 本身失敗（例如檔案被永久刪除），才走到這裡重新建立
    }
  }
  const ss = SpreadsheetApp.create('單據審核 - ' + project.name);
  const sheet = ss.getSheets()[0];
  sheet.setName('待審核單據');
  setupReviewSheetHeaders_(sheet);
  saveProjectReviewSheet_(project, ss.getId(), ss.getUrl());

  // 放進主資料夾下的「專案審核表」子資料夾，方便集中管理
  try {
    DriveApp.getFileById(ss.getId()).moveTo(findOrCreateSubfolder_(getRootFolder_(), '專案審核表'));
  } catch (e) {
    console.error('搬移審核表到資料夾失敗（不影響功能）：' + e);
  }
  return ss;
}

function applyProjectPermissions_(ss, project) {
  const sheet = ss.getSheets()[0];

  // 1. 分享給審核人（編輯者）
  project.approverEmails.forEach(function (email) {
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
    sheet.getRange(2, REVIEW_EDITABLE_START_COL, sheet.getMaxRows() - 1, REVIEW_EDITABLE_COL_COUNT),
  ]);

  // 3. 審核狀態、審核人做成下拉選單，避免打錯字導致同步比對失敗
  const maxRows = sheet.getMaxRows() - 1;
  sheet.getRange(2, REVIEW_EDITABLE_START_COL, maxRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build()
  );
  const approverNames = project.approverEmails.map(approverDisplayName_);
  if (approverNames.length > 0) {
    sheet.getRange(2, REVIEW_EDITABLE_START_COL + 1, maxRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(approverNames, true).setAllowInvalid(false).build()
    );
  }

  // 4. 裝一個「安裝式觸發條件」在這份審核表上，主管一按下「已退回」立刻通知申請人（見 onReviewStatusEdit_）。
  //    這是獨立於每天的總表同步之外的機制——退件通知要即時，不代表總表同步也要改成即時，兩件事分開處理。
  ensureReviewEditTrigger_(ss);
}

// 確保每份審核表都裝了退件即時通知的觸發條件，重複執行這個選單不會裝出好幾個重複的。
function ensureReviewEditTrigger_(ss) {
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onReviewStatusEdit_' && t.getTriggerSourceId() === ss.getId();
  });
  if (already) return;
  ScriptApp.newTrigger('onReviewStatusEdit_').forSpreadsheet(ss).onEdit().create();
}

function appendToProjectReviewSheet_(record, fileUrl) {
  const project = findProject_(record.project);
  if (!project) {
    // 專案不在「專案設定」裡：不要沉默失敗，明確記錄下來，方便從執行紀錄查到
    throw new Error('專案「' + record.project + '」不在「' + PROJECTS_SHEET_NAME + '」分頁中，未建立審核列');
  }
  if (project.status === PROJECT_STATUS_ENDED) {
    throw new Error('專案「' + record.project + '」已標記為已結束，未建立審核列');
  }
  const ss = getOrCreateProjectSpreadsheet_(project);
  const sheet = ss.getSheets()[0];
  sheet.appendRow([
    formatDateTime_(record.uploadedAt), record.uploader, record.invoiceDate, record.amount,
    record.items, record.vendor, record.purpose, record.budgetItem || '',
    record.payMethod || '', record.payee || '', record.paymentDetail || '', record.cardConfirmNote || '',
    record.urgent ? '緊急' : '一般', record.expectedPayoutDate || '', fileUrl,
    '待審核', '', '', '', '', record.id,
  ]);
  setCompleteCheckbox_(sheet, sheet.getLastRow(), REVIEW_COMPLETE_COL); // 只對剛寫入的這一列設勾選框
}

/* ============================================================
   同步：審核結果（審核表→總表）＋ 付款日期（總表→審核表）
   ============================================================ */
function syncApprovalsToMaster() {
  const master = getSheet_();
  const lastRow = master.getLastRow();
  if (lastRow < 2) return 0;

  const all = master.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const rowById = {};
  all.forEach(function (row, i) {
    const id = row[MASTER_RECORD_ID_COL - 1];
    if (id) rowById[id] = i + 2;
  });

  let updated = 0;

  loadConfig_().projects.forEach(function (project) {
    if (!project.reviewSheetId) return;
    let sheet;
    try {
      sheet = SpreadsheetApp.openById(project.reviewSheetId).getSheets()[0];
    } catch (e) {
      console.error('開啟 ' + project.name + ' 審核表失敗：' + e);
      return;
    }
    const rLast = sheet.getLastRow();
    if (rLast < 2) return;
    const rows = sheet.getRange(2, 1, rLast - 1, REVIEW_HEADERS.length).getValues();

    rows.forEach(function (row, idx) {
      const recordId = row[REVIEW_RECORD_ID_COL - 1];
      if (!recordId) return;
      const masterRow = rowById[recordId];
      if (!masterRow) return;
      const masterData = all[masterRow - 2];

      // (A) 審核結果：審核表 → 總表
      const status = row[REVIEW_EDITABLE_START_COL - 1];
      const reviewer = row[REVIEW_EDITABLE_START_COL];
      const note = row[REVIEW_EDITABLE_START_COL + 1];
      const statusChanged = status && status !== '待審核' &&
        (masterData[MASTER_STATUS_COL - 1] !== status ||
         masterData[MASTER_STATUS_COL] !== reviewer ||
         masterData[MASTER_STATUS_COL + 2] !== note);

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
        sheet.getRange(idx + 2, REVIEW_COMPLETE_COL).setValue(masterComplete);
        updated++;
      }

      // (C) 付款日期：總表 → 審核表（財務在總表填，主管在審核表看得到）
      const masterPaid = formatDateOnly_(masterData[MASTER_PAYDATE_COL - 1]);
      const reviewPaid = formatDateOnly_(row[REVIEW_PAYDATE_COL - 1]);
      if (masterPaid && masterPaid !== reviewPaid) {
        sheet.getRange(idx + 2, REVIEW_PAYDATE_COL).setValue(masterPaid);
        updated++;
      }
    });
  });
  return updated;
}

function syncApprovalsNow() {
  const n = syncApprovalsToMaster();
  SpreadsheetApp.getUi().alert('同步完成，共更新 ' + n + ' 筆（審核結果與付款日期）。');
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

// 純文字顯示用（不會觸發通知）
function projectApproverMentionText_(projectName) {
  const project = findProject_(projectName);
  if (!project || project.approverEmails.length === 0) return '（未設定審核人）';
  return project.approverEmails.map(approverDisplayName_).join('、');
}

// 真正會 tag 到人、讓對方跳通知的版本，只用在「緊急」單據。
// 一般彙總刻意不用這個，避免例行提醒打擾審核人。
function projectApproverPingText_(projectName) {
  const project = findProject_(projectName);
  if (!project || project.approverEmails.length === 0) return '（未設定審核人）';
  return project.approverEmails.map(function (email) {
    const person = personByEmail_(email);
    return (person && person.slackId) ? '<@' + person.slackId + '>'
      : approverDisplayName_(email) + '（尚未設定 Slack ID，不會跳通知）';
  }).join(' ');
}

function reviewSheetUrl_(projectName) {
  const project = findProject_(projectName);
  if (!project || !project.reviewSheetId) return '';
  try {
    return SpreadsheetApp.openById(project.reviewSheetId).getUrl();
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
    if (range.getSheet().getName() !== '待審核單據') return;
    if (range.getColumn() !== REVIEW_EDITABLE_START_COL || range.getNumColumns() !== 1 || range.getNumRows() !== 1) return;
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
    const uploader = rowData[1];
    const invoiceDate = formatDateOnly_(rowData[2]); // 同一個老問題：欄位有時被 Sheets 自動轉成真正的日期物件，直接印會變成一長串英文
    const amount = rowData[3];
    const items = rowData[4];
    const vendor = rowData[5];
    const rejectReason = rowData[REVIEW_EDITABLE_START_COL + 1] || '（審核人未填寫原因）';

    // 這個處理函式是共用的（每份審核表都裝同一個），要靠觸發來源的試算表 ID 反查是哪個專案
    const ssId = e.source ? e.source.getId() : sheet.getParent().getId();
    const allProjects = loadConfig_().projects;
    const project = allProjects.find(function (p) { return p.reviewSheetId === ssId; });
    // 暫時的除錯資訊：對不到專案時，把實際比對的兩邊原始值印出來，抓到原因後會拿掉這段。
    const projectName = project ? project.name
      : '（未知專案｜除錯：ssId=' + ssId + '｜已知審核表ID=' + allProjects.map(function (p) { return p.name + ':' + p.reviewSheetId; }).join('，') + '）';

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

// 每月固定的審核日提醒：不管有沒有待審項目，一律用 <!channel> 發一句提醒 + 各專案審核表連結
function sendPendingDigestToSlack() {
  const lines = ['📋 <!channel> 今天是各位主管的審核日，請記得審核喔！', ''];
  activeProjects_().forEach(function (project) {
    const url = reviewSheetUrl_(project.name);
    lines.push('• ' + project.name + (url ? ' → ' + url : '（尚未建立審核表，先執行選單「① 建立/更新設定與審核表」）'));
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
  if (lastRow < 2) {
    ui.alert('目前總表沒有任何資料。');
    return;
  }

  const values = master.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
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
    byProject[project].amount += Number(row[4]) || 0; // 第 5 欄＝金額
    total++;
    totalAmount += Number(row[4]) || 0;
  });

  if (total === 0) {
    ui.alert('本月（' + thisMonth + '）還沒有任何已填付款日期的紀錄，未發送通知。');
    return;
  }

  const lines = ['💰 <!channel> 本月（' + thisMonth + '）已完成付款 ' + total + ' 筆，合計 NT$ ' + totalAmount.toLocaleString('en-US'), ''];
  Object.keys(byProject).forEach(function (project) {
    lines.push('• ' + project + '：' + byProject[project].count + ' 筆，NT$ ' + byProject[project].amount.toLocaleString('en-US'));
  });
  lines.push('', '款項已匯出，明細可查看各專案審核表的「付款日期」欄。');
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
