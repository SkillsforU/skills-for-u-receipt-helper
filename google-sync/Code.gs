/**
 * Skills for U｜單據小幫手 — Google Sheets / Drive 同步接收端
 *
 * 使用方式：
 * 1. 開一個 Google 試算表（或用現有的收支表）。
 * 2. 上方選單「擴充功能」→「Apps Script」，把這個檔案整份貼進去（覆蓋原本的內容）。
 * 3. 把下面 SECRET_TOKEN 改成你自己的一串密碼（英數字，越隨機越好）。
 * 4. 需要的話調整 SHEET_NAME（要寫入哪個分頁）與 DRIVE_FOLDER_ID（憑證存到哪個資料夾）。
 * 5. 右上角「部署」→「新增部署作業」→類型選「網頁應用程式」：
 *      - 執行身分：我（你自己的帳號）
 *      - 誰可以存取：任何人
 *    部署後會拿到一個網址（結尾是 /exec），把它跟 SECRET_TOKEN 貼到「單據小幫手」網頁的
 *    「雲端同步設定」頁面裡即可。
 *
 * 安全性提醒：「誰可以存取：任何人」代表這個網址是公開的，任何人拿到網址 + 正確的
 * SECRET_TOKEN 就能寫資料進來。請不要公開分享這個網址與密碼；如果不小心外流，
 * 回到 Apps Script 改一個新的 SECRET_TOKEN 並重新部署即可失效舊的存取權。
 *
 * 想順便開啟「雲端 OCR」（用 Gemini 辨識單據，效果比純離線辨識好）：
 * 1. 到 https://aistudio.google.com/apikey 用同一個 Google 帳號申請一組 API 金鑰（有免費額度）。
 * 2. 把下面 GEMINI_API_KEY 改成你申請到的金鑰。
 * 3. 存檔後回到「部署」→「管理部署作業」→ 編輯（鉛筆圖示）→ 版本選「新版本」→ 部署，讓改動生效。
 * 4. 回到「單據小幫手」的「雲端同步設定」頁，勾選「使用雲端 OCR」、儲存設定即可。
 * 這組金鑰跟 SECRET_TOKEN 一樣是敏感資訊，不要外流；沒填的話「雲端 OCR」功能就不會被使用，
 * 工具會自動改用瀏覽器內建的離線辨識，不影響其他功能。
 */

const SHEET_NAME = '收支表';       // 要寫入的分頁名稱，找不到會自動建立
const DRIVE_FOLDER_ID = '';        // 留空 = 自動在「我的雲端硬碟」建立「單據小幫手」資料夾
const SECRET_TOKEN = '請改成你自己的密碼字串';
const GEMINI_API_KEY = '';         // 留空 = 不啟用雲端 OCR；到 Google AI Studio 申請後貼在這裡
// 預設用 gemini-flash-latest 這個別名，它會自動指向目前最新的 Flash 模型，
// 不會因為 Google 淘汰舊版本（回傳 404 no longer available）而突然失效。
// 若要指定特定模型，先到 https://ai.dev/rate-limit 確認你的帳號對它有額度：
// 顯示 0/0 代表沒額度、用了會噴 429；TTS 系列是語音用的，不能辨識單據。
const GEMINI_MODEL = 'gemini-flash-latest';

// 欄位順序＝寫進試算表的實際順序。若要調整順序或欄位，這裡跟 createRow_ / updateRow_ 裡的
// 欄位索引（getRange 的第 2 個參數）要一起改，兩邊沒對齊會寫錯欄。
const HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '發票日期', '金額', '單據內容', '公司名稱', '用途',
  '所屬期間', '狀態', '審核人', '審核時間', '退回原因', '憑證檔名', '憑證雲端連結',
  '紀錄ID',
];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SECRET_TOKEN) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }
    if (body.action === 'ocr') {
      return jsonOut_(recognizeReceipt_(body.imageDataUrl));
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

// imageDataUrl 可以是圖片（image/jpeg、image/png）或 PDF（application/pdf）的 data URL，
// Gemini 兩種都能直接讀取，不需要額外轉檔。
function recognizeReceipt_(imageDataUrl) {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: '尚未設定 GEMINI_API_KEY，未啟用雲端 OCR' };
  }
  const match = String(imageDataUrl || '').match(/^data:(.+);base64,(.*)$/);
  if (!match) return { ok: false, error: '找不到圖片或 PDF 資料' };
  const mimeType = match[1];
  const base64Data = match[2];

  const prompt = '你是台灣財務單據辨識助理。這份文件可能是圖片，也可能是含多頁的 PDF；' +
    '如果是多頁 PDF，裡面可能只有其中一頁是真正的發票或收據，其他頁可能是空白、附言或其他不相關內容，' +
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
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } },
      ],
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
    // 保留較長的錯誤內容，429 時 Google 會在這裡說明是「每分鐘」還是「每天」的額度用完
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

// 讓瀏覽器可以先用 GET 測試網址是否部署成功。
// 這裡會一併回報目前「這個部署版本」實際使用的模型，方便確認部署有沒有更新到最新程式碼
//（只顯示模型名稱與金鑰是否已設定，不會外洩金鑰內容）。
function doGet(e) {
  return jsonOut_({
    ok: true,
    message: '單據小幫手同步端點運作中，請用 POST 送資料。',
    model: GEMINI_MODEL,
    geminiKeySet: GEMINI_API_KEY ? true : false,
  });
}

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

// 依「所屬期間」（record.period，格式 YYYY-MM）在主資料夾下開一個 YYYYMM 命名的子資料夾，
// 例如 2026-07 → 子資料夾「202607」；找不到期間就歸到「未分類」。
function getMonthFolder_(period) {
  const root = getRootFolder_();
  const folderName = period ? String(period).replace(/-/g, '') : '未分類';
  const it = root.getFoldersByName(folderName);
  if (it.hasNext()) return it.next();
  return root.createFolder(folderName);
}

function saveFile_(record) {
  if (!record.fileDataUrl) return '';
  const match = String(record.fileDataUrl).match(/^data:(.+);base64,(.*)$/);
  if (!match) return '';
  const contentType = match[1];
  const bytes = Utilities.base64Decode(match[2]);
  const blob = Utilities.newBlob(bytes, contentType, record.fileName || 'receipt.jpg');
  const file = getMonthFolder_(record.period).createFile(blob);
  return file.getUrl();
}

function createRow_(sheet, record) {
  const fileUrl = saveFile_(record);
  // 順序要跟 HEADERS 一一對應
  sheet.appendRow([
    formatDateTime_(record.uploadedAt), record.uploader, record.project, record.invoiceDate,
    record.amount, record.items, record.vendor, record.purpose,
    record.period, statusLabel_(record.status),
    record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
    record.fileName, fileUrl, record.id,
  ]);
  return { ok: true, fileUrl: fileUrl };
}

// 紀錄ID 放在最後一欄（第 16 欄），updateRow_ 靠它找到要更新的那一列，
// 所以不能整欄刪除，只是不放在最前面而已。
const RECORD_ID_COL = 16;
const STATUS_COL = 10; // 狀態、審核人、審核時間、退回原因＝第 10~13 欄，四欄連續

function findRowById_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, RECORD_ID_COL, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

function updateRow_(sheet, record) {
  const rowIndex = findRowById_(sheet, record.id);
  if (rowIndex === -1) return createRow_(sheet, record);
  sheet.getRange(rowIndex, STATUS_COL, 1, 4).setValues([[
    statusLabel_(record.status), record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
  ]]);
  return { ok: true };
}

function statusLabel_(status) {
  return { pending: '待審核', approved: '已核准', rejected: '已退回' }[status] || status;
}

// 把 ISO 時間字串換算成 GMT+8、只顯示到分鐘，例如 "2026-07-31 14:23"
function formatDateTime_(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 授權用測試函式。設定好 GEMINI_API_KEY 後，在編輯器上方的函式下拉選單選「testGeminiAuth」
 * 並按「執行」，Google 會跳出授權畫面（要允許「連線至外部服務」這項權限），
 * 之後雲端 OCR 才不會出現「你沒有呼叫 UrlFetchApp.fetch 的權限」錯誤。
 *
 * 注意：函式名稱結尾「不能」有底線，否則 Apps Script 會視為私有函式而不顯示在下拉選單中。
 */
function testGeminiAuth() {
  var tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  Logger.log(JSON.stringify(recognizeReceipt_(tinyImage)));
}
