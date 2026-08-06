/**
 * Skills for U｜單據小幫手 — Google Sheets / Drive 同步 + 專案審核 + Slack 通知
 *
 * ── 第一次設定 ─────────────────────────────────────────────
 * 1. 開一個 Google 試算表（這份就是「總表」），選單「擴充功能」→「Apps Script」，把這個檔案整份貼進去。
 * 2. 修改下面「設定區」：SECRET_TOKEN、GEMINI_API_KEY、SLACK_WEBHOOK_URL、PROJECT_APPROVERS。
 * 3. 右上角「部署」→「新增部署作業」→「網頁應用程式」：執行身分「我」、誰可以存取「任何人」。
 *    把拿到的 /exec 網址跟 SECRET_TOKEN 貼到「單據小幫手」網頁的「雲端同步設定」。
 * 4. 重新整理總表，上方會多一個「單據小幫手」選單，點「① 建立/更新各專案審核表」。
 *    這會依 PROJECT_APPROVERS 幫每個專案建立獨立的審核用試算表、設好權限、並分享給審核人。
 * 5. 點「② 設定自動排程」，安裝兩個定時任務：
 *      - 每 15 分鐘把各專案的審核結果同步回總表
 *      - 每月 13 號早上把待審清單發到 Slack（@channel 通知頻道所有人）
 *
 * ── 權限模型 ───────────────────────────────────────────────
 * 每個專案有自己獨立的試算表，只分享給該專案的審核人（編輯者）。
 * 表內除了「審核狀態／審核人／審核備註」三欄之外，全部鎖定不可編輯，
 * 所以審核人只能改審核結果，不能竄改單據原始資料。
 *
 * ── 安全性提醒 ─────────────────────────────────────────────
 * 網頁應用程式設成「任何人」可存取，代表拿到網址 + SECRET_TOKEN 就能寫資料進來。
 * 請勿公開分享網址與密碼；外流時改一組新的 SECRET_TOKEN 並重新部署即可失效舊的存取權。
 * GEMINI_API_KEY 與 SLACK_WEBHOOK_URL 同樣是機密，不要外流。
 */

/* ============================================================
   設定區
   ============================================================ */
const SHEET_NAME = '收支表';       // 總表裡要寫入的分頁名稱，找不到會自動建立
const DRIVE_FOLDER_ID = '';        // 留空 = 自動在「我的雲端硬碟」建立「單據小幫手」資料夾
const SECRET_TOKEN = '請改成你自己的密碼字串';
const GEMINI_API_KEY = '';         // 留空 = 不啟用雲端 OCR
// 預設用 gemini-flash-latest 這個別名，它會自動指向目前最新的 Flash 模型，
// 不會因為 Google 淘汰舊版本（回傳 404 no longer available）而突然失效。
const GEMINI_MODEL = 'gemini-flash-latest';

// Slack 傳入 Webhook 網址。留空 = 不發送任何 Slack 通知（其他功能不受影響）。
// 申請方式：Slack → 你的工作區 → Apps → 搜尋「Incoming Webhooks」→ 選一個頻道 → 複製網址。
const SLACK_WEBHOOK_URL = '';

// 各專案的審核人。key 要跟「單據小幫手」名單設定裡的專案名稱「完全一致」（含繁簡、空格）。
const PROJECT_APPROVERS = {
  '組織發展中心':     ['ceo@skillsforu.org', 'rosyhu@skillsforu.org'],
  '高雄技職年會':     ['ceo@skillsforu.org', 'rein@skillsforu.org'],
  '臺灣技職教育年會': ['ceo@skillsforu.org', 'daphnekuo@skillsforu.org'],
  '組織行銷中心':     ['ceo@skillsforu.org'],
  '人才培育中心':     ['ceo@skillsforu.org'],
};

// 各專案的 email → Slack 個人 ID（用於發訊息時 @ 到正確的人）。
// 抓法：Slack 點開那個人的個人檔案卡片 → 「⋯ 更多」→「複製會員 ID」。沒填的人就只會用純文字顯示名字，不會真的 tag 到。
const SLACK_USER_IDS = {
  'ceo@skillsforu.org': 'U03KJN0VBL3',       // 偉翔
  'rosyhu@skillsforu.org': 'U0B56HTQFSR',    // 琬茜
  'rein@skillsforu.org': 'U0AKP8GT3B3',      // 梓豪
  'daphnekuo@skillsforu.org': 'U07GAACQALW', // Daphne
};

// 各專案憑證要存進哪個 Google Drive 資料夾。留空 = 自動在主資料夾（見上面 DRIVE_FOLDER_ID）底下
// 建立一個同名資料夾；填了資料夾 ID 就直接用你指定的現成資料夾。
// 資料夾 ID 取法：打開資料夾，網址列 https://drive.google.com/drive/folders/「這一串」就是 ID。
const PROJECT_FOLDER_IDS = {
  '組織發展中心':     '',
  '高雄技職年會':     '',
  '臺灣技職教育年會': '',
  '組織行銷中心':     '',
  '人才培育中心':     '',
};

// email → 顯示名稱，用於審核人下拉選單與 Slack 訊息
const APPROVER_NAMES = {
  'ceo@skillsforu.org': '偉翔',
  'rosyhu@skillsforu.org': '琬茜',
  'rein@skillsforu.org': '梓豪',
  'daphnekuo@skillsforu.org': 'Daphne',
};

/* ============================================================
   欄位定義
   ============================================================ */
// 總表欄位順序。調整時 createRow_ / updateRow_ / 下面的欄位索引常數要一起改。
const HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '發票日期', '金額', '單據內容', '公司名稱', '用途',
  '所屬期間', '急迫性', '狀態', '審核人', '審核時間', '退回原因', '憑證檔名', '憑證雲端連結',
  '紀錄ID',
];
const MASTER_STATUS_COL = 11;   // 狀態、審核人、審核時間、退回原因＝第 11~14 欄（四欄連續）
const MASTER_RECORD_ID_COL = 17;

// 各專案審核表的欄位。前 9 欄唯讀，最後 3 欄開放給審核人編輯。
const REVIEW_HEADERS = [
  '上傳時間', '上傳者', '發票日期', '金額', '單據內容', '公司名稱', '用途', '急迫性', '憑證連結',
  '審核狀態', '審核人', '審核備註', '紀錄ID',
];
const REVIEW_EDITABLE_START_COL = 10; // 審核狀態
const REVIEW_EDITABLE_COL_COUNT = 3;  // 審核狀態、審核人、審核備註
const REVIEW_RECORD_ID_COL = 13;

const CONFIG_SHEET_NAME = '系統設定';
const STATUS_OPTIONS = ['待審核', '已核准', '已退回'];

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
      // imageDataUrls（陣列）＝ PDF 在瀏覽器端轉成的多頁壓縮圖片；沒有的話退回單一張 imageDataUrl（可能是圖片，也可能是原始 PDF）
      const images = Array.isArray(body.imageDataUrls) && body.imageDataUrls.length ? body.imageDataUrls : [body.imageDataUrl];
      return jsonOut_(recognizeReceipt_(images));
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
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return jsonOut_({
    ok: true,
    message: '單據小幫手同步端點運作中，請用 POST 送資料。',
    model: GEMINI_MODEL,
    geminiKeySet: GEMINI_API_KEY ? true : false,
    slackSet: SLACK_WEBHOOK_URL ? true : false,
  });
}

/* ============================================================
   雲端 OCR（Gemini）
   ============================================================ */
// images：一或多張圖片／PDF 的 data URL 陣列。多張的情況通常是瀏覽器端把一份多頁 PDF 轉成的
// 各頁壓縮圖片（比整份原始 PDF 小很多，辨識明顯較快），也相容單純傳一張圖片或一份原始 PDF 的舊用法。
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
    '請只回傳以下格式的 JSON，不要有任何其他文字或說明：' +
    '{"invoiceDate": "YYYY-MM-DD 格式的發票或收據日期，找不到則為 null", ' +
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
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  return sheet;
}

function getRootFolder_() {
  if (DRIVE_FOLDER_ID) return DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const name = '單據小幫手';
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

function findOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

// 依專案找資料夾：PROJECT_FOLDER_IDS 有指定就直接用那個現成資料夾，
// 沒指定就在主資料夾底下自動建立/沿用一個同名資料夾。
function getProjectFolder_(project) {
  const explicitId = PROJECT_FOLDER_IDS[project];
  if (explicitId) return DriveApp.getFolderById(explicitId);
  return findOrCreateSubfolder_(getRootFolder_(), project || '未分類專案');
}

// 專案資料夾底下再依「所屬期間」（YYYY-MM）開 YYYYMM 子資料夾，找不到期間就歸到「未分類」
function getMonthFolder_(project, period) {
  const projectFolder = getProjectFolder_(project);
  const folderName = period ? String(period).replace(/-/g, '') : '未分類';
  return findOrCreateSubfolder_(projectFolder, folderName);
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
    record.amount, record.items, record.vendor, record.purpose,
    record.period, record.urgent ? '緊急' : '一般', statusLabel_(record.status),
    record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
    record.fileName, fileUrl, record.id,
  ]);

  // 同步一份到該專案的審核表，供主管審核
  try {
    appendToProjectReviewSheet_(record, fileUrl);
  } catch (err) {
    // 審核表寫入失敗不應該讓整筆上傳失敗，記在 log 就好
    console.error('寫入專案審核表失敗：' + err);
  }

  // 緊急件立刻發 Slack；一般件等定期彙總
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

function updateRow_(sheet, record) {
  const rowIndex = findRowById_(sheet, record.id, MASTER_RECORD_ID_COL);
  if (rowIndex === -1) return createRow_(sheet, record);
  sheet.getRange(rowIndex, MASTER_STATUS_COL, 1, 4).setValues([[
    statusLabel_(record.status), record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
  ]]);
  return { ok: true };
}

// 給「上傳紀錄」頁按「重新整理狀態」用：回傳總表目前每一筆紀錄的審核狀態，
// 讓小幫手網頁能把本機資料跟 Google 試算表上（透過各專案審核表同步回來的）最新結果對齊。
// 資料量大到有效能疑慮時，可以改成只回傳某個時間點之後有更新的列，目前量小先簡單處理。
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
      reviewedAt: row[MASTER_STATUS_COL + 1],
      rejectReason: row[MASTER_STATUS_COL + 2],
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

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   系統設定分頁：記住每個專案審核表的檔案 ID
   （用 ID 而非檔名/路徑，所以你之後把檔案搬到別的資料夾也不會壞）
   ============================================================ */
function getConfigSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET_NAME);
    sheet.appendRow(['專案名稱', '審核表檔案ID', '審核表網址']);
  }
  return sheet;
}

function getProjectFileId_(project) {
  const sheet = getConfigSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === project) return values[i][1];
  }
  return '';
}

function setProjectFileId_(project, fileId, url) {
  const sheet = getConfigSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === project) {
        sheet.getRange(i + 2, 2, 1, 2).setValues([[fileId, url]]);
        return;
      }
    }
  }
  sheet.appendRow([project, fileId, url]);
}

/* ============================================================
   建立 / 更新各專案審核表
   ============================================================ */
function setupProjectReviewSheets() {
  const created = [];
  Object.keys(PROJECT_APPROVERS).forEach(function (project) {
    const ss = getOrCreateProjectSpreadsheet_(project);
    applyProjectPermissions_(ss, project);
    created.push(project);
  });
  SpreadsheetApp.getUi().alert(
    '已建立/更新 ' + created.length + ' 個專案審核表：\n\n' + created.join('\n') +
    '\n\n各審核表的網址可在「' + CONFIG_SHEET_NAME + '」分頁查看，已自動分享給對應的審核人。'
  );
}

function getOrCreateProjectSpreadsheet_(project) {
  const existingId = getProjectFileId_(project);
  if (existingId) {
    try {
      return SpreadsheetApp.openById(existingId);
    } catch (e) {
      // 檔案被刪掉了，往下重新建立
    }
  }
  const ss = SpreadsheetApp.create('單據審核 - ' + project);
  const sheet = ss.getSheets()[0];
  sheet.setName('待審核單據');
  sheet.appendRow(REVIEW_HEADERS);
  sheet.setFrozenRows(1);
  setProjectFileId_(project, ss.getId(), ss.getUrl());

  // 放進主資料夾下的「專案審核表」子資料夾，方便集中管理
  try {
    const root = getRootFolder_();
    const folderName = '專案審核表';
    const it = root.getFoldersByName(folderName);
    const folder = it.hasNext() ? it.next() : root.createFolder(folderName);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  } catch (e) {
    console.error('搬移審核表到資料夾失敗（不影響功能）：' + e);
  }
  return ss;
}

function applyProjectPermissions_(ss, project) {
  const approvers = PROJECT_APPROVERS[project] || [];
  const sheet = ss.getSheets()[0];

  // 1. 分享給審核人（編輯者）
  approvers.forEach(function (email) {
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
  const protection = sheet.protect().setDescription('單據資料唯讀，僅開放審核欄位');
  protection.removeEditors(protection.getEditors());
  protection.setUnprotectedRanges([
    sheet.getRange(2, REVIEW_EDITABLE_START_COL, sheet.getMaxRows() - 1, REVIEW_EDITABLE_COL_COUNT),
  ]);

  // 3. 審核狀態、審核人做成下拉選單，避免打錯字導致同步比對失敗
  const maxRows = sheet.getMaxRows() - 1;
  sheet.getRange(2, REVIEW_EDITABLE_START_COL, maxRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build()
  );
  const approverNames = approvers.map(function (e) { return APPROVER_NAMES[e] || e; });
  if (approverNames.length > 0) {
    sheet.getRange(2, REVIEW_EDITABLE_START_COL + 1, maxRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(approverNames, true).setAllowInvalid(false).build()
    );
  }
}

function appendToProjectReviewSheet_(record, fileUrl) {
  if (!PROJECT_APPROVERS[record.project]) return; // 沒設定審核人的專案就不建審核表
  const ss = getOrCreateProjectSpreadsheet_(record.project);
  const sheet = ss.getSheets()[0];
  sheet.appendRow([
    formatDateTime_(record.uploadedAt), record.uploader, record.invoiceDate, record.amount,
    record.items, record.vendor, record.purpose, record.urgent ? '緊急' : '一般', fileUrl,
    '待審核', '', '', record.id,
  ]);
}

/* ============================================================
   把各專案審核結果同步回總表（定時執行）
   ============================================================ */
function syncApprovalsToMaster() {
  const master = getSheet_();
  const lastRow = master.getLastRow();
  if (lastRow < 2) return 0;

  // 先把總表現有的 紀錄ID → 列號 建成索引，避免每筆都重新掃一次
  const masterIds = master.getRange(2, MASTER_RECORD_ID_COL, lastRow - 1, 1).getValues();
  const rowById = {};
  masterIds.forEach(function (row, i) { if (row[0]) rowById[row[0]] = i + 2; });

  const masterStatuses = master.getRange(2, MASTER_STATUS_COL, lastRow - 1, 4).getValues();
  let updated = 0;

  Object.keys(PROJECT_APPROVERS).forEach(function (project) {
    const fileId = getProjectFileId_(project);
    if (!fileId) return;
    let sheet;
    try {
      sheet = SpreadsheetApp.openById(fileId).getSheets()[0];
    } catch (e) {
      console.error('開啟 ' + project + ' 審核表失敗：' + e);
      return;
    }
    const rLast = sheet.getLastRow();
    if (rLast < 2) return;
    const rows = sheet.getRange(2, 1, rLast - 1, REVIEW_HEADERS.length).getValues();

    rows.forEach(function (row) {
      const status = row[REVIEW_EDITABLE_START_COL - 1];
      const reviewer = row[REVIEW_EDITABLE_START_COL];
      const note = row[REVIEW_EDITABLE_START_COL + 1];
      const recordId = row[REVIEW_RECORD_ID_COL - 1];
      if (!recordId || !status || status === '待審核') return;

      const masterRow = rowById[recordId];
      if (!masterRow) return;
      const current = masterStatuses[masterRow - 2];
      // 狀態、審核人、備註都沒變就跳過，避免每次都重寫整張表
      if (current[0] === status && current[1] === reviewer && current[3] === note) return;

      master.getRange(masterRow, MASTER_STATUS_COL, 1, 4).setValues([[
        status, reviewer, formatDateTime_(new Date().toISOString()), note,
      ]]);
      updated++;
    });
  });
  return updated;
}

function syncApprovalsNow() {
  const n = syncApprovalsToMaster();
  SpreadsheetApp.getUi().alert('同步完成，共更新 ' + n + ' 筆審核結果。');
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

// 純文字顯示用（例如「審核人：偉翔、琬茜」這種描述句），不會真的觸發通知
function projectApproverMentionText_(project) {
  const approvers = (PROJECT_APPROVERS[project] || []).map(function (e) { return APPROVER_NAMES[e] || e; });
  return approvers.length ? approvers.join('、') : '（未設定審核人）';
}

// 真正會 tag 到人、讓對方跳出通知的版本，只用在「緊急」單據（notifyUrgentToSlack_）。
// 一般彙總刻意不用這個，避免每週都用真的 @ 打擾審核人。
// SLACK_USER_IDS 有填該人的 Slack ID 才會是真的 @提及；沒填的人就退回顯示純文字名字。
function projectApproverPingText_(project) {
  const approvers = PROJECT_APPROVERS[project] || [];
  if (approvers.length === 0) return '（未設定審核人）';
  return approvers.map(function (email) {
    const slackId = SLACK_USER_IDS[email];
    return slackId ? '<@' + slackId + '>' : (APPROVER_NAMES[email] || email) + '（尚未設定 Slack ID，不會跳通知）';
  }).join(' ');
}

function notifyUrgentToSlack_(record, fileUrl) {
  const reviewUrl = getProjectFileId_(record.project)
    ? SpreadsheetApp.openById(getProjectFileId_(record.project)).getUrl() : '';
  const lines = [
    '🚨 *有一筆緊急單據待審核*　' + projectApproverPingText_(record.project),
    '專案：' + record.project,
    '上傳者：' + record.uploader,
    '金額：NT$ ' + (record.amount || 0),
    '用途：' + (record.purpose || record.items || '—'),
    fileUrl ? '憑證：' + fileUrl : '',
    reviewUrl ? '前往審核：' + reviewUrl : '',
  ];
  postToSlack_(lines.filter(Boolean).join('\n'));
}

const DIGEST_DAY_OF_MONTH = 10; // 每月審核日；遇到週六/週日會自動順延到下一個週一（最晚仍會落在 13 號前）

// 排程專用：每天執行一次，只有輪到「本月審核日」（已考慮週末順延）才真的發送。
// 手動測試請用選單「立即發送待審核提醒到 Slack」，那個是呼叫下面 sendPendingDigestToSlack()，
// 不受日期限制，隨時按都會真的送出。
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

// 每月固定的審核日提醒：不管有沒有待審項目，一律用 <!channel>（等於「@all」）發一句提醒，
// 附上每個專案審核表的連結，養成大家固定日子進去看一輪的習慣。
function sendPendingDigestToSlack() {
  const lines = ['📋 <!channel> 今天是各位主管的審核日，請記得審核喔！', ''];
  Object.keys(PROJECT_APPROVERS).forEach(function (project) {
    const fileId = getProjectFileId_(project);
    let url = '';
    try { url = fileId ? SpreadsheetApp.openById(fileId).getUrl() : ''; } catch (e) {}
    lines.push('• ' + project + (url ? ' → ' + url : '（尚未建立審核表，先執行選單「① 建立/更新各專案審核表」）'));
  });
  postToSlack_(lines.join('\n'));
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

  // 每天固定時間同步一次即可（審核集中在每月固定幾天，緊急件用選單「立即同步審核結果」手動處理）。
  // 想改回更頻繁，把這行換成 .everyMinutes(15)（只能填 1/5/10/15/30）。
  ScriptApp.newTrigger('syncApprovalsToMaster').timeBased().everyDays(1).atHour(23).create();
  // 改成每天檢查一次（是不是「本月審核日」由 isReviewReminderDay_() 判斷，含週末順延邏輯），
  // 而不是直接用 onMonthDay，這樣才能在 13 號遇到週末時自動改發下一個週一。
  ScriptApp.newTrigger('sendScheduledDigestIfDue_').timeBased().everyDays(1).atHour(10).create();

  SpreadsheetApp.getUi().alert(
    '已設定自動排程：\n\n' +
    '• 每天晚上 11 點左右把各專案審核結果同步回總表（Apps Script 只能指定「幾點」，不保證精確到分鐘）\n' +
    '• 每月 ' + DIGEST_DAY_OF_MONTH + ' 號上午 10 點發送審核提醒到 Slack（會 @channel 通知頻道所有人；若當天是週六/週日會自動順延到下一個週一）\n\n' +
    '想馬上同步不想等，用選單「立即同步審核結果」；想改日期，改 Code.gs 裡的 DIGEST_DAY_OF_MONTH 後重新執行這個選單即可。'
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('單據小幫手')
    .addItem('① 建立/更新各專案審核表', 'setupProjectReviewSheets')
    .addItem('② 設定自動排程', 'setupTriggers')
    .addSeparator()
    .addItem('立即同步審核結果', 'syncApprovalsNow')
    .addItem('立即發送待審提醒到 Slack', 'sendPendingDigestToSlack')
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
