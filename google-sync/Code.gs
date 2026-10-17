/**
 * Skills for U｜核銷小幫手 — Google Sheets / Drive 同步 + 中心審核 + Slack 通知
 *
 * ── 組織架構 ───────────────────────────────────────────────
 * 「中心」是最上層（例如組織發展中心、品牌行銷中心、人才培育中心），審核表現在「一個中心一份」，
 * 底下的「專案」共用同一份審核表，靠「所屬專案」欄分辨每一列屬於哪個專案。審核人也是設在中心層級，
 * 一個中心底下所有專案都由同一批人審核。Drive 資料夾結構是「中心／專案／年月」。
 *
 * ── 第一次設定 ─────────────────────────────────────────────
 * 1. 開一個 Google 試算表（這份就是「總表」），選單「擴充功能」→「Apps Script」，把這個檔案整份貼進去。
 * 2. 機密值（GEMINI_API_KEY、SLACK_WEBHOOK_URL）填在 Apps Script 左側「專案設定」（齒輪）→「指令碼屬性」，
 *    屬性名稱就用這兩個名字，**不要寫進程式碼**（GitHub 是公開的）。
 *    GOOGLE_CLIENT_ID（Google 登入用戶端 ID，非機密）直接改下面的常數。
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
 * 這兩個機密值只存在「指令碼屬性」，程式碼裡永遠留空（見 getSecret_）。
 * 要收回某人存取權：把他從 Google Workspace 停用即可，不需要像舊版那樣換密碼重部署。
 */

/* ============================================================
   設定區（機密值不在這裡，見下方「機密值」說明）
   ============================================================ */
const SHEET_NAME = '收支總表';     // 總表裡要寫入的分頁名稱，找不到會自動建立
const DRIVE_FOLDER_ID = '16Ia8f6zt7K3Uh7FQbzKUxCYTJ35Wm-Mr';        // 留空 = 自動在「我的雲端硬碟」建立「核銷小幫手」資料夾

const REVIEW_SHEETS_FOLDER_ID = '1yd8pwY-ZWfBreVD-qaj40J14Vs-tpqcM';
// 「中心審核表」存放資料夾的 ID（固定指定，避免每次靠名字找而不小心生出重複的資料夾）。
// 留空 = 退回「在主資料夾底下用名字找/建一個『中心審核表』子資料夾」。

// v2 起改用「Google 登入」驗證身分，取代舊的 SECRET_TOKEN 密碼。
// 前端會要求同事用組織帳號（@skillsforu.org）登入 Google，拿到一張「身分證明」(ID token)
// 隨每次請求送來；這裡驗證那張證明是不是真的、是不是這個系統的、是不是組織網域，才准寫資料。
// GOOGLE_CLIENT_ID 是在 Google Cloud「用戶端」建立的網頁應用程式用戶端 ID（不是機密，可公開）。
const GOOGLE_CLIENT_ID = '367734743259-m1si6lu02113c1e53v80t4gnf40poop0.apps.googleusercontent.com';
const ALLOWED_EMAIL_DOMAIN = 'skillsforu.org'; // 只允許這個網域的 Google 帳號使用
const SECRET_TOKEN = '';           // 已停用（保留常數避免其他參照壞掉）；驗證改看 Google 登入

// ── 機密值：存在「指令碼屬性」，不寫在程式碼裡 ─────────────────────
// GEMINI_API_KEY、SLACK_WEBHOOK_URL 請到 Apps Script 左側「專案設定」（齒輪）→「指令碼屬性」新增，
// 屬性名稱就用這兩個名字。程式會優先讀指令碼屬性。
// 好處：以後更新後端只要「整份貼上 GitHub 最新版 → 部署新版本」，不用每次補填機密值；
// 換 key、換 Slack 頻道也只要改屬性、存檔就立即生效，連重新部署都不用。
// 下面兩個同名常數只是舊作法的相容備援（指令碼屬性沒設時才會用到），請永遠保持空白。
const GEMINI_API_KEY = '';         // 請保持空白，改用指令碼屬性 GEMINI_API_KEY（兩邊都空 = 不啟用雲端 OCR）
const SLACK_WEBHOOK_URL = '';      // 請保持空白，改用指令碼屬性 SLACK_WEBHOOK_URL（兩邊都空 = 不發 Slack，其他功能不受影響）
// 2026-10 起 Slack 分兩個頻道：
//   SLACK_WEBHOOK_URL         → #組織布告欄-組織事項宣布用（全體同仁：審核提醒、退件、已匯出、補件通知）
//   SLACK_WEBHOOK_URL_ORGDEV  → #team-組織發展中心（財務內部：放行請求、已放行、整批退回）
// 財務內部的訊息有整批金額，沒設定 SLACK_WEBHOOK_URL_ORGDEV 時「不會」改發到布告欄，只會不發（見 postToSlack_）。

// 前端網址（不是機密）。Slack 訊息裡的「到核銷小幫手核對」連結用它，前端換網址時這裡要跟著改。
const APP_URL = 'https://skills-for-u-receipt-helper.vercel.app/';

/* ── 預覽測試模式 ─────────────────────────────────────────────
   （選用，平常不用）想在「總表的副本」上試用新版、完全不碰正式資料時用：
   1. 正式總表 →「檔案 → 建立副本」（Apps Script 會一起複製），副本名稱要有「預覽」或「測試」。
   2. 在副本貼上新版程式碼，重新整理後執行選單「🧪 設成預覽測試用副本」。
   之後這份副本：
   • Slack 一律不真的發，改寫進「Slack預覽」分頁（看得到原本會發什麼）
   • 上傳的檔案、各中心審核表都放在新的「核銷小幫手（預覽測試）」資料夾，不進正式資料夾
   • 新建的審核表不會自動分享給審核人（不會寄共用通知給大家）
   正式總表永遠不會有 PREVIEW_MODE 這個指令碼屬性，所以這段在正式環境完全不作用。 */
const PREVIEW_MODE_PROP_ = 'PREVIEW_MODE';
// 正式總表的 ID（交接文件第 8 節也有）：預覽測試模式在這份上「永遠」不會開，就算有人誤按選單或誤加屬性也一樣
const PRODUCTION_MASTER_SPREADSHEET_ID = '13WKP764RsWJdBFs-yGvDdkQzbzqMzrnzZ6BWNb9__Rk';
const PREVIEW_ROOT_FOLDER_PROP_ = 'PREVIEW_ROOT_FOLDER_ID';
const PREVIEW_APP_URL = ''; // 預覽網站網址（只影響「Slack預覽」分頁裡訊息的連結），留空就用 APP_URL
const SLACK_PREVIEW_SHEET_NAME = 'Slack預覽';

// 預設用 gemini-flash-latest 這個別名，它會自動指向目前最新的 Flash 模型，
// 不會因為 Google 淘汰舊版本（回傳 404 no longer available）而突然失效。
const GEMINI_MODEL = 'gemini-flash-latest';

const DIGEST_DAY_OF_MONTH = 10;    // 每月審核日；遇到週六/週日會自動順延到下一個週一

// 讀機密值：先讀「指令碼屬性」，沒有才退回上面同名常數。
// 每次用到才讀（不在檔案最上層先讀好）：改了屬性立刻生效，就算讀取出錯也只影響這一項功能，不會讓整份程式載入失敗。
function getSecret_(name, legacyValue) {
  let value = '';
  try {
    value = PropertiesService.getScriptProperties().getProperty(name) || '';
  } catch (e) {
    console.warn('讀取指令碼屬性 ' + name + ' 失敗，改用程式碼裡的常數：' + e);
  }
  value = String(value).trim();
  return value || String(legacyValue || '').trim();
}
// 回報機密值目前從哪裡讀到（scriptProperties／code／none），只回來源、不回值本身。
function secretSource_(name, legacyValue) {
  let fromProps = '';
  try { fromProps = PropertiesService.getScriptProperties().getProperty(name) || ''; } catch (e) { /* 讀不到就當沒設 */ }
  if (String(fromProps).trim()) return 'scriptProperties';
  if (String(legacyValue || '').trim()) return 'code';
  return 'none';
}
function geminiApiKey_() { return getSecret_('GEMINI_API_KEY', GEMINI_API_KEY); }
function isPreviewMode_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(MASTER_SPREADSHEET_ID_PROP_) === PRODUCTION_MASTER_SPREADSHEET_ID) return false;
    return props.getProperty(PREVIEW_MODE_PROP_) === 'on';
  } catch (e) {
    return false;
  }
}
function appUrl_() {
  return (isPreviewMode_() && PREVIEW_APP_URL) ? PREVIEW_APP_URL : APP_URL;
}
// target：'finance' → 財務內部頻道；其他（預設）→ 全體同仁的布告欄頻道
function slackWebhookUrl_(target) {
  if (target === 'finance') return getSecret_('SLACK_WEBHOOK_URL_ORGDEV', '');
  return getSecret_('SLACK_WEBHOOK_URL', SLACK_WEBHOOK_URL);
}

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
  ['品牌行銷中心', 'ceo@skillsforu.org', '進行中', ''],
  ['人才培育中心', 'ceo@skillsforu.org', '進行中', ''],
];
const SEED_PROJECTS = [
  // [專案名稱, 所屬中心, 狀態, 憑證資料夾ID]
  // 每個中心先各自帶一個跟中心同名的「一般行政」專案，代表「不屬於任何特定專案、算中心的一般開銷」。
  ['組織發展中心', '組織發展中心', '進行中', ''],
  ['品牌行銷中心', '品牌行銷中心', '進行中', ''],
  ['人才培育中心', '人才培育中心', '進行中', ''],
];

/* ============================================================
   欄位定義
   ============================================================ */
// 總表欄位順序。調整時 createRow_ 的寫入順序與下面的欄位位置常數要一起改。
// 第 1 列留給人工填寫的「自動帶入／手動填寫（誰）」標註，程式不會去動它；
// 標題實際寫在第 2 列，真正的資料從第 3 列開始（見 getSheet_ / findRowById_ 等處的列位置）。
// 欄位順序＝ Rosy 2026-09-17 在總表上排好的版本（財務要看的欄位集中在一起）。
// 「單據內容/發票內容」已拿掉（看憑證即可）；「確認事項」一欄身兼「信用卡紙本兩項確認」與
// 「報價金額不符原因」（兩者幾乎不會同時發生，真的同時就把兩段文字接在一起）。
// 2026-10 起在最後面（AF 欄起）追加 7 欄結構化的付款資料，給之後的「付款批次」與兆豐整批付款檔直接取用：
// 以前匯款帳號只有一格自由填寫的「付款資訊」，會出現「帳號請參考網銀記錄」這類會計沒辦法直接用的內容。
// 新欄位一律加在最後面、不插在中間，既有 31 欄的位置完全不動（舊資料不用搬）；既有總表第一次跑到新版程式時，
// ensureMasterHeaders_ 會自動補上這幾欄的標題。
const HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '單據類型', '發票日期', '本次金額', '報價總額', '用途', '公司名稱',
  '付款狀態', '付款方式', '信用卡形式', '還款對象', '收款對象', '付款資訊', '確認事項', '關聯報價單',
  '急迫性', '期望撥款日期', '狀態', '審核人', '審核時間', '退回原因', '單據完備', '付款日期', '會計科目',
  '預算項目', '所屬期間', '憑證檔名', '憑證雲端連結', '紀錄ID',
  '收款戶名', '收款銀行', '分行代碼', '收款帳號', '發票號碼', '每月固定支出', '繳費期限',
  '付款批次', '放行備註', '紙本核對備註',
];
const MASTER_LEGACY_COL_COUNT = 31; // 2026-10 以前的欄數；這之後的欄位是後來追加的，見 ensureMasterHeaders_
// ⚠️ 欄位位置一律用下面這些常數，程式各處都不要再直接寫死數字。
// 這樣之後調整 HEADERS 順序時，只要改這一區的數字，其他地方會自動跟著對；
// 漏改一個寫死的數字會讓資料靜靜寫到隔壁欄，而且完全不會報錯——這裡是唯一的真相來源。
// （注意：改這裡「不會」搬動試算表上已經存在的舊資料，那仍然要人工在 Sheets 裡處理。）
const MASTER_UPLOAD_TIME_COL = 1;
const MASTER_UPLOADER_COL = 2;
const MASTER_PROJECT_COL = 3;
const MASTER_DOCTYPE_COL = 4;         // 單據類型：發票 / 收據（合一）／報價單
const MASTER_INVOICE_DATE_COL = 5;
const MASTER_AMOUNT_COL = 6;          // 本次金額（這一筆實際要付/已付的錢；分次時是單次金額）
const MASTER_QUOTE_TOTAL_COL = 7;     // 報價總額（只有報價單會填，用來對照分次已付/尚欠）
const MASTER_PURPOSE_COL = 8;
const MASTER_VENDOR_COL = 9;
const MASTER_PAYSTATUS_COL = 10;      // 付款狀態：已付款／未付款（判斷基準＝組織的錢出去了沒）
const MASTER_PAYMETHOD_COL = 11;      // 付款方式：組織信用卡／零用金／組織匯款
const MASTER_CARDFORM_COL = 12;       // 信用卡形式：連結／紙本（僅未付款・組織信用卡）
const MASTER_REPAY_TARGET_COL = 13;   // 還款對象：組織人員／外部廠商
const MASTER_PAYEE_COL = 14;          // 收款對象：實際人名或廠商名
const MASTER_PAYINFO_COL = 15;        // 付款資訊：帳號／刷卡連結
const MASTER_CONFIRM_COL = 16;        // 確認事項：信用卡紙本兩項確認／報價金額不符原因（身兼兩用）
const MASTER_LINKED_QUOTE_COL = 17;   // 關聯報價單：這筆後續款掛在哪張報價單的紀錄ID底下
const MASTER_URGENCY_COL = 18;
const MASTER_EXPECTED_PAYOUT_COL = 19;
const MASTER_STATUS_COL = 20;    // 狀態、審核人、審核時間、退回原因＝連續四欄（同步時整批寫入）
const MASTER_REVIEWER_COL = 21;
const MASTER_REVIEWED_AT_COL = 22;
const MASTER_REJECT_REASON_COL = 23;
const MASTER_COMPLETE_COL = 24;  // 單據完備，由後勤人員手動勾選
const MASTER_PAYDATE_COL = 25;   // 付款日期，由財務手動填，會同步到各中心審核表
const MASTER_GLCODE_COL = 26;    // 會計科目，財務手動選（下拉選單），純總表內部使用，不同步到審核表
const MASTER_BUDGET_ITEM_COL = 27;
const MASTER_PERIOD_COL = 28;    // 所屬期間，決定憑證存到哪個年月資料夾
const MASTER_FILE_NAME_COL = 29;
const MASTER_FILE_URL_COL = 30;  // 憑證雲端連結，退回時要靠它找到檔案搬到「已退回」資料夾
const MASTER_RECORD_ID_COL = 31;
// ↓ 2026-10 追加（AF～AL）。分行代碼、收款帳號、繳費期限一律存成純文字，
//   不然 Sheets 會把開頭的 0 吃掉（0081234 → 81234），或把長帳號變成科學記號、把日期轉成日期格式。
const MASTER_PAYEE_ACCOUNT_NAME_COL = 32; // 收款戶名（匯款給廠商／外部個人時，跟存摺上的戶名一樣）
const MASTER_PAYEE_BANK_COL = 33;         // 收款銀行（由分行代碼前 3 碼對出來的銀行名稱，方便人看）
const MASTER_PAYEE_BRANCH_COL = 34;       // 分行代碼（7 碼＝銀行 3 碼＋分行 4 碼），純文字
const MASTER_PAYEE_ACCOUNT_COL = 35;      // 收款帳號（只有數字），純文字；一定緊接在分行代碼後面（createRow_ 兩欄一起寫）
const MASTER_INVOICE_NO_COL = 36;         // 發票號碼（AI 辨識後同仁核對，收據可空白）
const MASTER_FIXED_EXPENSE_COL = 37;      // 每月固定支出：「是」或空白
const MASTER_BILL_DUE_COL = 38;           // 繳費期限（繳費單才有），純文字 yyyy-MM-dd
// ↓ 2026-10「財務作業」追加（AM～AO），由網頁的財務作業寫入，不用手動填
const MASTER_BATCH_ID_COL = 39;           // 付款批次：這筆是在哪一批付掉的（確認已付款時寫入，對應「付款批次」分頁的批次ID）
const MASTER_RELEASE_NOTE_COL = 40;       // 放行備註：放行人標「不放行」時的原因；之後付款成功會清掉
const MASTER_PAPER_NOTE_COL = 41;         // 紙本核對備註：會計核對紙本「有問題」時寫的原因；按「紙本相符」或「復原」會清掉
const MASTER_TEXT_COLS_ADDED_ = [MASTER_PAYEE_BRANCH_COL, MASTER_PAYEE_ACCOUNT_COL, MASTER_BILL_DUE_COL];

// 中心審核表裡實際放單據資料的分頁名稱。程式一律用這個名字去找分頁，
// 不能假設它是「這份試算表的第一個分頁」——如果有人在前面手動加了別的分頁
// （例如放使用說明），單據就會寫錯地方，而且不會有任何錯誤提示（真實發生過一次）。
const REVIEW_SHEET_NAME = '待審核單據';

// 中心審核表的欄位（一個中心一份，底下所有專案共用同一份，靠「所屬專案」欄分辨）。
// 除了「審核狀態／審核人／審核備註」三欄，其餘都鎖定唯讀。第 1 列同樣留給人工標註，標題在第 2 列，資料第 3 列起。
// 審核表欄位順序比照總表的分組（付款相關集中），拿掉「單據內容」、「信用卡紙本確認」改成「確認事項」。
// 審核三欄（審核狀態／審核人／審核備註）必須連續，保護範圍靠 REVIEW_EDITABLE_START_COL 開洞。
const REVIEW_HEADERS = [
  '上傳時間', '上傳者', '所屬專案', '單據類型', '發票日期', '本次金額', '報價總額', '用途', '公司名稱',
  '付款狀態', '付款方式', '信用卡形式', '還款對象', '收款對象', '付款資訊', '確認事項', '關聯報價單',
  '急迫性', '期望撥款日期', '憑證連結', '審核狀態', '審核人', '審核備註', '單據完備', '付款日期', '預算項目', '紀錄ID',
];
const REVIEW_UPLOADER_COL = 2;
const REVIEW_PROJECT_COL = 3;
const REVIEW_DOCTYPE_COL = 4;
const REVIEW_INVOICE_DATE_COL = 5;
const REVIEW_AMOUNT_COL = 6;
const REVIEW_QUOTE_TOTAL_COL = 7;
const REVIEW_PURPOSE_COL = 8;
const REVIEW_VENDOR_COL = 9;
const REVIEW_PAYSTATUS_COL = 10;
const REVIEW_PAYMETHOD_COL = 11;
const REVIEW_CARDFORM_COL = 12;
const REVIEW_REPAY_TARGET_COL = 13;
const REVIEW_PAYEE_COL = 14;
const REVIEW_PAYINFO_COL = 15;
const REVIEW_CONFIRM_COL = 16;        // 確認事項（同總表 MASTER_CONFIRM_COL）
const REVIEW_LINKED_QUOTE_COL = 17;
const REVIEW_URGENCY_COL = 18;
const REVIEW_EXPECTED_PAYOUT_COL = 19;
const REVIEW_FILE_URL_COL = 20;
const REVIEW_EDITABLE_START_COL = 21; // 審核狀態
const REVIEW_EDITABLE_COL_COUNT = 3;  // 審核狀態、審核人、審核備註（三欄連續，保護範圍靠這個開洞）
const REVIEW_REVIEWER_COL = 22;
const REVIEW_NOTE_COL = 23;            // 審核備註（主管填）
const REVIEW_COMPLETE_COL = 24;       // 單據完備，由總表同步過來（後勤在總表勾選）
const REVIEW_PAYDATE_COL = 25;        // 由總表同步過來，審核人不能改
const REVIEW_BUDGET_ITEM_COL = 26;
const REVIEW_RECORD_ID_COL = 27;

const PEOPLE_SHEET_NAME = '人員設定';
const CENTERS_SHEET_NAME = '中心設定';
const PROJECTS_SHEET_NAME = '專案設定';
const BUDGET_SHEET_NAME = '預算項目設定';
const GLCODE_SHEET_NAME = '會計科目設定';
// 「財務角色」（2026-10 新增）決定誰看得到網頁的「財務作業」分頁：
//   會計＝產生付款批次、送出放行請求、確認已付款、記到藍途、核對紙本
//   放行＝在「待放行」核對後放行／不放行／整批退回（Slack 放行請求也會 tag 這些人）
// 一個人可以兩個都填（用「、」隔開），但系統不讓同一個人放行自己送出的批次（跟兆豐的雙人控管一致）。
const PEOPLE_HEADERS = ['姓名', 'Email', 'Slack個人ID', '財務角色'];
const FINANCE_ROLE_ACCOUNTANT = '會計';
const FINANCE_ROLE_RELEASER = '放行';
const FINANCE_ROLES = [FINANCE_ROLE_ACCOUNTANT, FINANCE_ROLE_RELEASER];
const CENTERS_HEADERS = ['中心名稱', '審核人Email（逗號分隔）', '狀態', '主資料夾ID', '審核表ID（自動產生，勿手動修改）', '審核表連結'];
const CENTERS_REVIEW_SHEET_ID_COL = 5; // 審核表ID、審核表連結＝第 5~6 欄（兩欄連續，saveCenterReviewSheet_ 一次寫入）
const PROJECTS_HEADERS = ['專案名稱', '所屬中心', '狀態', '憑證資料夾ID'];
// 「預算金額」是 2026-10 新增的 E 欄，給「計畫與預算」頁算執行率用（沒填不影響上傳）
const BUDGET_HEADERS = ['專案/中心', '預算類別', '預算項目', '對應會計科目', '預算金額'];
// 財務自己維護這張清單，總表「會計科目」欄的下拉選單直接讀 A 欄（會自動跟著清單增減）；
// B 欄「藍途代碼」是藍途記帳的 4 位數會計項目代碼，產生藍途匯入檔時用來帶入「會計項目代碼」欄。
const GLCODE_HEADERS = ['會計科目', '藍途代碼'];
// 上傳時真的不知道該歸哪一項時的保底選項，每個專案的下拉都會自動附加這個，
// 不需要在「預算項目設定」分頁裡手動幫每個專案各加一列。
const UNSPECIFIED_BUDGET_ITEM = '不確定預算項目';

const STATUS_OPTIONS = ['待審核', '已核准', '已退回'];
const PROJECT_STATUS_ACTIVE = '進行中';
const PROJECT_STATUS_ENDED = '已結束';

// v2 付款結構與報價單相關的選項（前端下拉、後端驗證共用同一組字，避免兩邊打不一樣對不上）
const DOC_TYPE_RECEIPT = '發票 / 收據';  // 發票、收據合成一個選項（要分辨看憑證即可）。一定要有檔案。
const DOC_TYPE_QUOTE = '報價單';         // 報價單。一定要有檔案。
const DOC_TYPE_NONE = '沒有單據';        // 這筆付款目前沒有任何單據（報價單後續款、之後才補發票）。允許不附檔案。
// ⚠️ 只有「發票 / 收據」才算「這個案子的發票到了」；報價單、沒有單據都不算——
//    所以就算金額沖滿，只要案子裡沒有任何一筆「發票 / 收據」，就還是「發票還沒來」、不會結清。
const DOC_TYPE_OPTIONS = [DOC_TYPE_RECEIPT, DOC_TYPE_QUOTE, DOC_TYPE_NONE];
const PAY_STATUS_PAID = '已付款';       // 組織的錢已經出去了（組織信用卡、零用金）
const PAY_STATUS_UNPAID = '未付款';     // 組織還沒付（組織匯款、未付款的組織信用卡）
const PAY_STATUS_OPTIONS = [PAY_STATUS_PAID, PAY_STATUS_UNPAID];
const REPAY_TARGET_MEMBER = '組織人員';  // 還款對象＝內部同仁（多半是代墊款）
const REPAY_TARGET_VENDOR = '外部廠商';  // 還款對象＝外部廠商
const REPAY_TARGET_OPTIONS = [REPAY_TARGET_MEMBER, REPAY_TARGET_VENDOR];
// 付款方式（跟前端 app.js 的 PM_* 一致）。「網銀代繳」是 2026-10 新增的：稅金、健保費這類繳費單，
// 會計用網路銀行代繳，不經過整批匯款，所以也不需要填收款帳號。
const PAY_METHOD_TRANSFER = '組織匯款';
const PAY_METHOD_BILL = '網銀代繳';

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
  readSheetRows_(peopleSheet, PEOPLE_HEADERS.length).forEach(function (r) {
    const name = String(r[0] || '').trim();
    if (!name) return;
    people.push({
      name: name,
      email: String(r[1] || '').trim(),
      slackId: String(r[2] || '').trim(),
      financeRoles: parseFinanceRoles_(r[3]),
    });
  });

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
  readSheetRows_(budgetSheet, BUDGET_HEADERS.length).forEach(function (r) {
    const project = String(r[0] || '').trim();
    const item = String(r[2] || '').trim();
    if (!project || !item) return; // 專案/中心、預算項目都是必填，缺一就跳過這列
    if (!budgetItemsByProject[project]) budgetItemsByProject[project] = [];
    budgetItemsByProject[project].push({
      category: String(r[1] || '').trim(),
      item: item,
      glCode: String(r[3] || '').trim(),
      // 預算金額可以打「150,000」「150000元」，只取數字；沒填＝0（計畫與預算頁會顯示「未設定」）
      budget: Number(String(r[4] === null || r[4] === undefined ? '' : r[4]).replace(/[^\d.]/g, '')) || 0,
      rawBudget: r[4],
    });
  });

  _configCache = {
    people: people, centers: centers, projects: projects,
    centersSheet: centersSheet, projectsSheet: projectsSheet,
    budgetItemsByProject: budgetItemsByProject,
  };
  return _configCache;
}

// 讀設定分頁第 2 列起的資料。欄數以「表格實際有的欄數」為上限再補空字串，
// 這樣設定分頁新增欄位（例如人員設定的「財務角色」）時，就算舊表格欄數不夠也不會因為範圍超出而整個讀取失敗。
function readSheetRows_(sheet, numCols) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const cols = Math.min(numCols, sheet.getMaxColumns());
  return sheet.getRange(2, 1, last - 1, cols).getValues().map(function (r) {
    const padded = r.slice();
    while (padded.length < numCols) padded.push('');
    return padded;
  });
}

// 「財務角色」欄：可以填「會計」「放行」，或兩個都填（「會計、放行」）；其他字一律忽略
function parseFinanceRoles_(value) {
  return String(value || '').split(/[、,，\/\s]+/).map(function (s) { return s.trim(); })
    .filter(function (s, i, arr) { return FINANCE_ROLES.indexOf(s) !== -1 && arr.indexOf(s) === i; });
}

// 設定分頁升級用：第 1 列只補「空白」的標題格，已經有字的一律不覆蓋。回傳有衝突（被別的標題佔用）的欄位說明。
function ensureSettingsHeaders_(sheet, headers) {
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  const row1 = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const conflicts = [];
  headers.forEach(function (h, i) {
    const current = String(row1[i] || '').trim();
    if (current === h) return;
    if (current === '') {
      sheet.getRange(1, i + 1).setValue(h);
    } else {
      conflicts.push('「' + sheet.getName() + '」第 ' + (i + 1) + ' 欄是「' + current + '」，系統預期是「' + h + '」');
    }
  });
  return conflicts;
}

// 預算項目 → 對應會計科目（「預算項目設定」D 欄）。上傳時自動帶進總表「會計科目」欄，財務之後仍可在總表改。
function glCodeForBudgetItem_(projectName, budgetItem) {
  const list = loadConfig_().budgetItemsByProject[projectName] || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].item === budgetItem) return list[i].glCode || '';
  }
  return '';
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
  return {
    ok: true, email: email, name: person ? person.name : email, unknownPerson: !person,
    financeRoles: person ? person.financeRoles : [],
  };
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
      // 一併回傳「你是誰」，讓前端顯示登入者、並把上傳人自動帶成本人（不再手選）；
      // financeRoles 決定前端要不要顯示「財務作業」分頁（真正的權限檢查在後端每個財務動作裡，見 requireFinanceRole_）
      const cfg = getConfigForApp_();
      cfg.me = {
        email: auth.email, name: auth.name, unknownPerson: auth.unknownPerson, financeRoles: auth.financeRoles,
        canViewBudget: canViewBudget_(auth.email), // 「計畫與預算」只開放給中心審核人和有財務角色的人
      };
      return jsonOut_(cfg);
    }
    if (String(body.action || '').indexOf('finance') === 0) {
      return jsonOut_(handleFinanceAction_(body, auth));
    }
    if (body.action === 'getStatuses') {
      return jsonOut_(getAllStatuses_());
    }
    // 團隊後台的三個頁面（首頁問手冊、認識組織、計畫與預算）
    if (body.action === 'askHandbook') return jsonOut_(askHandbook_(body, auth));
    if (body.action === 'askColleague') return jsonOut_(askColleague_(body, auth));
    if (body.action === 'getAbout') return jsonOut_(getAbout_());
    if (body.action === 'getAboutOverview') return jsonOut_(getAboutOverview_());
    if (body.action === 'getBudgetOverview') return jsonOut_(getBudgetOverview_(auth));
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
    geminiKeySet: geminiApiKey_() ? true : false,
    slackSet: slackWebhookUrl_() ? true : false,
    slackFinanceSet: slackWebhookUrl_('finance') ? true : false,
    // 機密值從哪裡讀到（只回來源、不回值）：部署後打開 /exec 網址，三個都顯示 scriptProperties 就代表設定正確
    geminiKeySource: secretSource_('GEMINI_API_KEY', GEMINI_API_KEY),
    slackSource: secretSource_('SLACK_WEBHOOK_URL', SLACK_WEBHOOK_URL),
    slackFinanceSource: secretSource_('SLACK_WEBHOOK_URL_ORGDEV', ''),
    previewMode: isPreviewMode_(),
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
    // 預覽網站會檢查這個：接到的後端不是預覽測試模式（＝正式總表）就停下來，不讓測試資料寫進正式總表
    previewMode: isPreviewMode_(),
  };
}

/* ============================================================
   雲端 OCR（Gemini）
   ============================================================ */
// images：一或多張圖片／PDF 的 data URL 陣列。多張通常是瀏覽器端把多頁 PDF 轉成的各頁壓縮圖片
//（比整份原始 PDF 小很多、辨識較快），也相容單純傳一張圖片或一份原始 PDF。
function recognizeReceipt_(images) {
  const apiKey = geminiApiKey_();
  if (!apiKey) {
    return { ok: false, error: '尚未設定 GEMINI_API_KEY（請到 Apps Script「專案設定 → 指令碼屬性」新增），未啟用雲端 OCR' };
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
    '"invoiceNumber": "台灣統一發票號碼（2 個英文字母＋8 位數字，例如 AB-12345678），收據或找不到則為 null", ' +
    '"confidence": 你對這次辨識結果整體正確性的信心百分比，0 到 100 的整數}';

  const payload = {
    contents: [{
      parts: [{ text: prompt }].concat(parsed.map(function (m) {
        return { inline_data: { mime_type: m[1], data: m[2] } };
      })),
    }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  // 金鑰放在 x-goog-api-key 標頭（Gemini 官方文件的寫法），不放在網址上，避免出現在任何網址紀錄裡；
  // 2026 年起 AI Studio 只發「AQ.」開頭的新型金鑰，同樣用這個標頭帶。
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  const fetchOpts = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
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
  // 欄數不夠就先在最後面補欄（新建的分頁預設只有 26 欄），後面讀寫第 2 列標題才不會超出表格範圍
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }
  if (headerRowBlank_(sheet, HEADERS.length)) {
    // 第 1 列刻意留空，給人工填寫「自動帶入／手動填寫（誰）」的標註用；標題直接寫在第 2 列，
    // 不用 appendRow（那樣會把標題寫到第 1 列去）。真正的資料從第 3 列開始寫入。
    sheet.getRange(2, 1, 1, sheet.getMaxColumns()).clearDataValidations(); // 寫標題前先清舊驗證，理由同 setupReviewSheetHeaders_
    sheet.getRange(2, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(2);
    // 「發票日期」「所屬期間」存的是我們自訂格式的純文字（YYYY-MM-DD / YYYY-MM），
    // 不先設成純文字格式，Sheets 會自動把它們轉成真正的日期儲存格，
    // 之後程式讀回來就會變成 Date 物件而不是原本的字串（例如資料夾名稱變成一長串英文日期）。
    [
      MASTER_INVOICE_DATE_COL, MASTER_PERIOD_COL, MASTER_EXPECTED_PAYOUT_COL,
      MASTER_REVIEWED_AT_COL, MASTER_PAYDATE_COL,
    ].concat(MASTER_TEXT_COLS_ADDED_).forEach(function (col) {
      sheet.getRange(3, col, sheet.getMaxRows() - 2, 1).setNumberFormat('@');
    });
    // 「單據完備」勾選框改成「每寫入一列才對那一列設定」（見 createRow_ 的 setCompleteCheckbox_），
    // 不在這裡對整欄一次設定——避免任何指令把一大段範圍都當成「有資料」，害 appendRow() 把
    // 新資料接到最後一列後面，而不是接在真正資料該開始的那一列。
    applyGlCodeDropdown_(sheet);
  }
  ensureMasterHeaders_(sheet);
  return sheet;
}

// 既有總表升級到「有追加欄位」的新版程式時，第 2 列只有舊的 31 個標題——上面 headerRowBlank_ 的防線
// 不會動它（第 2 列不是空的）。這裡專門補「追加欄位」的標題，規則很保守：
//   • 只補「空白」的標題格，已經有字的格子一律不覆蓋。
//   • 追加欄位的位置如果已經被別的標題佔用（例如有人在 AE 欄後面手動加了「備註」欄），就直接報錯停下來，
//     不寫入任何資料——不然新欄位的值會靜靜寫進別人的欄位，付款資料錯欄是最不能發生的事。
//   • 欄數不夠就先在最後面加欄，再設定純文字格式（分行代碼、帳號、繳費期限）。
// 每次寫入前都會跑一次，但標題都在的時候只讀一列，很快。
function ensureMasterHeaders_(sheet) {
  const need = HEADERS.length;
  if (sheet.getMaxColumns() < need) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
  }
  const row2 = sheet.getRange(2, 1, 1, need).getValues()[0];
  let wrote = false;
  for (let i = MASTER_LEGACY_COL_COUNT; i < need; i++) {
    const current = String(row2[i] || '').trim();
    if (current === HEADERS[i]) continue;
    if (current !== '') {
      throw new Error(
        '總表「' + SHEET_NAME + '」第 2 列第 ' + (i + 1) + ' 欄已經有標題「' + current + '」，' +
        '但系統要在這一欄放「' + HEADERS[i] + '」。為了避免付款資料寫錯欄，這次先不寫入。' +
        '請把手動加的欄位移到所有系統欄位的後面（第 ' + (need + 1) + ' 欄之後），再重新送出。'
      );
    }
    sheet.getRange(2, i + 1).setValue(HEADERS[i]);
    wrote = true;
  }
  if (wrote) {
    MASTER_TEXT_COLS_ADDED_.forEach(function (col) {
      sheet.getRange(3, col, sheet.getMaxRows() - 2, 1).setNumberFormat('@');
    });
  }
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
  if (isPreviewMode_()) {
    const previewId = getSecret_(PREVIEW_ROOT_FOLDER_PROP_, '');
    if (!previewId) throw new Error('預覽測試模式還沒設定好資料夾，請在總表副本執行選單「🧪 設成預覽測試用副本」。');
    return DriveApp.getFolderById(previewId);
  }
  if (DRIVE_FOLDER_ID) return DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const name = '核銷小幫手';
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

// 中心審核表要放進哪個資料夾：有指定 REVIEW_SHEETS_FOLDER_ID 就用那個現成資料夾（最穩，
// 不會靠名字找而生出重複資料夾）；沒指定才退回「在主資料夾底下用名字找/建『中心審核表』子資料夾」。
function getReviewSheetsFolder_() {
  if (!isPreviewMode_() && REVIEW_SHEETS_FOLDER_ID) return DriveApp.getFolderById(REVIEW_SHEETS_FOLDER_ID);
  return findOrCreateSubfolder_(getRootFolder_(), '中心審核表');
}

function findOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

// 依中心找資料夾：「中心設定」有填主資料夾ID 就用那個現成資料夾，沒填就在主資料夾底下建同名資料夾
function getCenterFolder_(centerName) {
  const center = findCenter_(centerName);
  if (center && center.folderId && !isPreviewMode_()) return DriveApp.getFolderById(center.folderId);
  return findOrCreateSubfolder_(getRootFolder_(), centerName || '未分類中心');
}

// 依專案找資料夾，路徑是「中心／專案」：「專案設定」有填憑證資料夾ID 就直接用那個現成資料夾（不管它在哪個中心底下），
// 沒填就在該專案所屬中心的資料夾底下建一個同名子資料夾。
function getProjectFolder_(projectName) {
  const project = findProject_(projectName);
  if (project && project.folderId && !isPreviewMode_()) return DriveApp.getFolderById(project.folderId);
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

// 把網頁送來的付款欄位整理乾淨（分行代碼、帳號只留數字，補上銀行名稱），並組出一行人看得懂的「付款資訊」，
// 給總表「付款資訊」欄跟各中心審核表顯示用；結構化的欄位另外寫在總表最後面（AF～AL）給程式用。
// 舊版網頁（還沒更新的瀏覽器快取）只會送自由填寫的 paymentDetail，這裡照原樣保留，不會擋。
function normalizePaymentFields_(record) {
  const digits = function (v, max) { return String(v || '').replace(/\D/g, '').slice(0, max); };
  const branch = digits(record.payeeBranchCode, 7);
  const account = digits(record.payeeAccountNo, 20);
  const accountName = String(record.payeeAccountName || '').trim();
  const bankName = branch
    ? (String(record.payeeBankName || '').trim() || (branch.length >= 3 ? '銀行代碼 ' + branch.slice(0, 3) : ''))
    : '';
  const billDue = /^\d{4}-\d{2}-\d{2}$/.test(String(record.billDueDate || '')) ? String(record.billDueDate) : '';
  let paymentDetail = String(record.paymentDetail || '').trim();
  if (branch || account) {
    paymentDetail = '戶名：' + (accountName || '（未填）') + '｜' + (bankName || '銀行') + '（' + branch + '）｜帳號：' + account;
  } else if (record.payMethod === PAY_METHOD_BILL) {
    paymentDetail = '繳費單，會計用網銀代繳';
  }
  return {
    accountName: accountName,
    bankName: bankName,
    branch: branch,
    account: account,
    billDue: billDue,
    invoiceNo: String(record.invoiceNumber || '').trim().toUpperCase(),
    fixedExpense: record.fixedExpense ? '是' : '',
    paymentDetail: paymentDetail,
  };
}

function createRow_(sheet, record) {
  const fileUrl = saveFile_(record);
  const pay = normalizePaymentFields_(record);
  record.paymentDetail = pay.paymentDetail; // 審核表的「付款資訊」也用同一份整理好的文字

  // 上鎖：兩個人同時送出時，appendRow 跟後面「補寫分行代碼／帳號到剛剛那一列」之間如果被插隊，
  // 帳號會寫到別人的那一列——付款資料錯列是不能發生的事，所以這一段一次只讓一個請求進來。
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // 欄位順序必須跟 HEADERS 完全一致（見上方常數區）。改這裡一定要跟著改 HEADERS，並跑驗證腳本。
    sheet.appendRow([
      formatDateTime_(record.uploadedAt), record.uploader, record.project, record.docType || DOC_TYPE_RECEIPT, record.invoiceDate,
      record.amount, record.quoteTotal || '', record.purpose, record.vendor,
      record.payStatus || '', record.payMethod || '', record.cardForm || '', record.repayTarget || '', record.payee || '',
      pay.paymentDetail, record.confirmNote || '', record.linkedQuoteId || '',
      record.urgent ? '緊急' : '一般', record.expectedPayoutDate || '', statusLabel_(record.status),
      record.reviewer, formatDateTime_(record.reviewedAt), record.rejectReason,
      '', // 單據完備，由會計在「財務作業 › 單據完備」核對紙本後勾選（也可以直接在總表勾）
      '', // 付款日期，由「財務作業」確認已付款時寫入（也可以直接在總表填）
      // 會計科目：依「預算項目設定」D 欄自動帶入；沒設定對應就留空，財務之後在總表下拉選單補選或修改
      glCodeForBudgetItem_(record.project, record.budgetItem),
      record.budgetItem || '', record.period,
      record.fileName, fileUrl, record.id,
      pay.accountName, pay.bankName,
      '', '', // 分行代碼、收款帳號：下面用純文字格式另外寫，不交給 appendRow（它會把開頭的 0 吃掉）
      pay.invoiceNo, pay.fixedExpense,
      '', // 繳費期限：同上，另外用純文字寫
    ]);
    const row = sheet.getLastRow();
    setCompleteCheckbox_(sheet, row, MASTER_COMPLETE_COL); // 只對剛寫入的這一列設勾選框
    if (pay.branch || pay.account) {
      sheet.getRange(row, MASTER_PAYEE_BRANCH_COL, 1, 2).setNumberFormat('@').setValues([[pay.branch, pay.account]]);
    }
    if (pay.billDue) {
      sheet.getRange(row, MASTER_BILL_DUE_COL).setNumberFormat('@').setValue(pay.billDue);
    }
  } finally {
    lock.releaseLock();
  }

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
      vendor: row[MASTER_VENDOR_COL - 1],
      purpose: row[MASTER_PURPOSE_COL - 1],
      budgetItem: row[MASTER_BUDGET_ITEM_COL - 1],
      period: row[MASTER_PERIOD_COL - 1],
      payStatus: row[MASTER_PAYSTATUS_COL - 1],
      payMethod: row[MASTER_PAYMETHOD_COL - 1],
      cardForm: row[MASTER_CARDFORM_COL - 1],
      repayTarget: row[MASTER_REPAY_TARGET_COL - 1],
      payee: row[MASTER_PAYEE_COL - 1],
      // 「上傳紀錄」所有同仁都看得到，帳號類的長數字只留末 4 碼（完整帳號只在總表與「財務作業」）
      paymentDetail: maskAccountNumbers_(row[MASTER_PAYINFO_COL - 1]),
      payeeAccountName: row[MASTER_PAYEE_ACCOUNT_NAME_COL - 1],
      payeeBankName: row[MASTER_PAYEE_BANK_COL - 1],
      payeeBranchCode: String(row[MASTER_PAYEE_BRANCH_COL - 1] || ''), // 分行代碼不是機密（只認得出哪家分行），可以完整顯示
      payeeAccountMasked: maskTail_(row[MASTER_PAYEE_ACCOUNT_COL - 1]),
      invoiceNumber: row[MASTER_INVOICE_NO_COL - 1],
      fixedExpense: row[MASTER_FIXED_EXPENSE_COL - 1] === '是',
      billDueDate: formatDateOnly_(row[MASTER_BILL_DUE_COL - 1]),
      confirmNote: row[MASTER_CONFIRM_COL - 1],
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
      // 放行時沒有付款的原因、紙本核對有問題的原因：上傳人在「上傳紀錄」看得到，才知道要補什麼
      releaseNote: maskAccountNumbers_(row[MASTER_RELEASE_NOTE_COL - 1]),
      paperNote: maskAccountNumbers_(row[MASTER_PAPER_NOTE_COL - 1]),
      batchId: row[MASTER_BATCH_ID_COL - 1],
    };
  }).filter(function (r) { return r.id; });
  return { ok: true, records: records };
}

// 帳號遮蔽：8 碼以上的連續數字（中間夾「-」或空格也算）只留末 4 碼，例如 94480081415416 → ****5416。
// 7 碼的分行代碼、金額不會被遮；yyyy-MM-dd 這種日期刻意略過（雖然也是 8 個數字）。
function maskAccountNumbers_(text) {
  return String(text || '').replace(/\d(?:[\d -]*\d)?/g, function (m) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(m)) return m;
    const d = m.replace(/\D/g, '');
    return d.length >= 8 ? '****' + d.slice(-4) : m;
  });
}
function maskTail_(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d ? '****' + d.slice(-4) : '';
}

// 報價單「補上正式發票」在新做法裡不再是特殊的「換單／自動退審」流程——它就只是「再上傳一筆
// 發票/收據、關聯到那張報價單」而已（見前端）。系統永遠不改任何已送出的金額、也不自動退審；
// 金額對不對、要不要追加或退回，交給人在前端處理。所以原本的 attachFinalDocument_ 及其
// 打回審核表重審的幾個輔助函式都拿掉了。

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
  const glSheet = getOrCreateSheet_(GLCODE_SHEET_NAME, GLCODE_HEADERS, []);

  // 設定分頁升級：舊表格補上後來新增的欄位標題（人員設定「財務角色」、會計科目設定「藍途代碼」），
  // 並建立「付款批次」分頁（財務作業用）。只補空白的標題格，不會覆蓋任何已經有字的格子。
  loadConfig_(); // 確保人員設定等分頁存在
  const headerConflicts = []
    .concat(ensureSettingsHeaders_(getOrCreateSheet_(PEOPLE_SHEET_NAME, PEOPLE_HEADERS, SEED_PEOPLE), PEOPLE_HEADERS))
    .concat(ensureSettingsHeaders_(getOrCreateSheet_(BUDGET_SHEET_NAME, BUDGET_HEADERS, []), BUDGET_HEADERS))
    .concat(ensureSettingsHeaders_(glSheet, GLCODE_HEADERS))
    // 手冊、最新消息已經記在「網站後台_資料導入連結」的話，總表就不用再建這兩個備用分頁
    .concat(handbookRows_().length ? [] : ensureSettingsHeaders_(getOrCreateSheet_(KNOWLEDGE_SHEET_NAME, KNOWLEDGE_HEADERS, []), KNOWLEDGE_HEADERS))
    .concat(registryFind_(NEWS_PURPOSE_PATTERN).length ? [] : ensureSettingsHeaders_(getOrCreateSheet_(NEWS_SHEET_NAME, NEWS_HEADERS, []), NEWS_HEADERS));
  getBatchSheet_();

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

  // 設定之間對不上的地方（改名沒改完、打錯字）一律講出來：這類問題平常不會報錯，
  // 只會讓同仁「選不到某個專案」或「寫入審核表失敗」，很難從網頁上看出原因。
  const configWarnings = headerConflicts.concat(configConsistencyWarnings_()).concat(registryWarnings_());
  const warningBlock = configWarnings.length > 0
    ? '\n\n⚠️ 設定需要確認：\n' + configWarnings.map(function (w) { return '• ' + w; }).join('\n')
    : '';

  SpreadsheetApp.getUi().alert(
    (isPreviewMode_() ? '🧪 預覽測試模式：Slack 不會真的發（寫進「' + SLACK_PREVIEW_SHEET_NAME + '」分頁），審核表不會分享給審核人。\n\n' : '') +
    '設定分頁與審核表已更新。\n\n' +
    '進行中中心（' + created.length + '）：\n' + (created.join('\n') || '（無）') +
    '\n\n已結束、略過的中心（' + skipped.length + '）：\n' + (skipped.join('\n') || '（無）') +
    warningBlock +
    strayBlock +
    '\n\n各中心審核表的網址可在「' + CENTERS_SHEET_NAME + '」分頁查看，已自動分享給對應的審核人。\n' +
    '要異動人員、專案、中心或預算項目，直接編輯「' + PEOPLE_SHEET_NAME + '」「' + PROJECTS_SHEET_NAME +
    '」「' + CENTERS_SHEET_NAME + '」「' + BUDGET_SHEET_NAME + '」分頁後再執行一次這個選單即可。'
  );
}

// 設定分頁之間對不上的地方，選單①會一併列出來（只提醒，不會自動改任何設定）
function configConsistencyWarnings_() {
  const cfg = loadConfig_();
  const warnings = [];
  const centerNames = cfg.centers.map(function (c) { return c.name; });
  cfg.projects.forEach(function (p) {
    if (!p.center) {
      warnings.push('「' + PROJECTS_SHEET_NAME + '」第 ' + p.rowIndex + ' 列「' + p.name + '」沒有填所屬中心，同仁選不到這個專案。');
    } else if (centerNames.indexOf(p.center) === -1) {
      warnings.push('「' + PROJECTS_SHEET_NAME + '」第 ' + p.rowIndex + ' 列「' + p.name + '」的所屬中心是「' + p.center +
        '」，但「' + CENTERS_SHEET_NAME + '」裡沒有這個中心（是不是改名沒改完？）。同仁選不到這個專案，寫入審核表也會失敗。');
    } else {
      const c = findCenter_(p.center);
      if (c.status === PROJECT_STATUS_ENDED && p.status !== PROJECT_STATUS_ENDED) {
        warnings.push('專案「' + p.name + '」所屬的中心「' + c.name + '」已結束，同仁選不到這個專案。');
      }
    }
  });
  const projectNames = cfg.projects.map(function (p) { return p.name; });
  Object.keys(cfg.budgetItemsByProject).forEach(function (name) {
    if (projectNames.indexOf(name) === -1) {
      warnings.push('「' + BUDGET_SHEET_NAME + '」裡的「' + name + '」不在「' + PROJECTS_SHEET_NAME + '」裡（是不是改名沒改完？），這幾列預算項目不會出現在上傳的下拉選單。');
    }
    cfg.budgetItemsByProject[name].forEach(function (b) {
      const raw = String(b.rawBudget === null || b.rawBudget === undefined ? '' : b.rawBudget).trim();
      if (raw && !b.budget) warnings.push('預算項目「' + name + '／' + b.item + '」的預算金額「' + raw + '」看不懂，請只填數字。');
    });
  });
  const glNames = Object.keys(loadGlCodeMap_());
  if (glNames.length) {
    Object.keys(cfg.budgetItemsByProject).forEach(function (name) {
      cfg.budgetItemsByProject[name].forEach(function (b) {
        if (b.glCode && glNames.indexOf(b.glCode) === -1) {
          warnings.push('預算項目「' + name + '／' + b.item + '」對應的會計科目「' + b.glCode + '」不在「' + GLCODE_SHEET_NAME + '」的清單裡。');
        }
      });
    });
  }
  const withRole = function (role) { return cfg.people.filter(function (p) { return p.financeRoles.indexOf(role) !== -1; }); };
  if (!withRole(FINANCE_ROLE_RELEASER).length) {
    warnings.push('「' + PEOPLE_SHEET_NAME + '」還沒有人的「財務角色」是「放行」：放行請求不會 tag 任何人，也沒有人能在網頁上放行。');
  }
  if (!withRole(FINANCE_ROLE_ACCOUNTANT).length) {
    warnings.push('「' + PEOPLE_SHEET_NAME + '」還沒有人的「財務角色」是「會計」：沒有人能操作付款批次。');
  }
  cfg.people.forEach(function (p) {
    if (p.financeRoles.length && !p.email) warnings.push('「' + p.name + '」有財務角色但沒有 Email，登入後系統認不出他。');
  });
  if (!loadKnowledgeEntries_().length) {
    warnings.push('「網站後台_資料導入連結」和總表的「' + KNOWLEDGE_SHEET_NAME + '」都還沒有填任何手冊：小U 回答不了組織的問題，「認識組織 › 組織文化與工作規範」的手冊區也會是空的。');
  }
  return warnings;
}

// 標題列、凍結、日期欄純文字格式——不管是「全新建立」還是「既有但被清空」的審核表都要補上，
// 兩種情況共用同一段邏輯，避免總表有這道防線、審核表卻漏掉：有人手動清空審核表內容
// （連標題一起刪）之後，系統就再也長不出標題列。第 1 列同總表，留給人工標註，標題寫在第 2 列，
// 真正的資料從第 3 列開始（審核表現在一個中心一份，多個專案共用同一份表，靠「所屬專案」欄分辨）。
function setupReviewSheetHeaders_(sheet) {
  // 寫標題前先把「標題列」的舊資料驗證清掉。踩過的坑：欄位重排後，某格（例如 V2）還卡著舊版
  // 「審核狀態」的下拉驗證（只准填 待審核/已核准/已退回），這時要把新標題「審核人」寫進 V2
  // 就會違反舊驗證、直接噴錯，害整個選單①中斷。先清掉這一列的驗證，寫標題就不會撞到。
  // 新建立的試算表預設只有 26 欄，審核表有 27 欄：不先補欄，下面寫標題會因為範圍超出表格而失敗
  if (sheet.getMaxColumns() < REVIEW_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), REVIEW_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(2, 1, 1, sheet.getMaxColumns()).clearDataValidations();
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
  // 只有「審核表ID 完全空白」時才會自動建立全新的一份。
  // ⚠️ 只要 ID 有填、卻打不開（永久刪除／沒有存取權／Google 暫時出錯），一律「明確報錯、不自動新建」——
  //    自動新建會產生第二份重複的審核表，還會把「審核表ID」改指到那份空的新表，
  //    讓原本那份（含所有審核資料）變成孤兒。真實踩過這個坑（組織發展中心跑出兩份）。
  //    要重建的話，請人工把該中心的「審核表ID」「審核表連結」兩欄清空後再執行選單①。
  if (center.reviewSheetId) {
    let existing;
    try {
      existing = SpreadsheetApp.openById(center.reviewSheetId);
    } catch (e) {
      throw new Error(
        '中心「' + center.name + '」的審核表（ID: ' + center.reviewSheetId + '）打不開' +
        '（可能被永久刪除、沒有存取權，或 Google 暫時出錯），未自動重建以免產生重複的審核表。' +
        '請確認「' + CENTERS_SHEET_NAME + '」分頁裡這個中心的「審核表ID」是否正確；' +
        '若確定要建一份全新的，請把該中心的「審核表ID」「審核表連結」兩欄清空後再執行選單①。'
      );
    }
    // openById 對「已丟進垃圾桶」的檔案不會報錯，還是打得開——不特別檢查的話，會一直往垃圾桶裡的
    // 舊檔案寫，新資料完全不會出現在該出現的地方。同樣明確報錯，不自動重建。
    if (DriveApp.getFileById(center.reviewSheetId).isTrashed()) {
      throw new Error(
        '中心「' + center.name + '」的審核表（ID: ' + center.reviewSheetId + '）目前在垃圾桶裡，' +
        '未自動重建。請到 Google 雲端硬碟垃圾桶把它復原，或是把「' + CENTERS_SHEET_NAME +
        '」分頁裡這個中心的「審核表ID」「審核表連結」兩欄清空後再重新執行這個選單，讓系統建立全新的審核表。'
      );
    }
    const existingSheet = getReviewSheet_(existing);
    // 有人手動把整份審核表的內容清空（連標題列一起刪）時補回標題，判斷方式見 headerRowBlank_。
    if (headerRowBlank_(existingSheet, REVIEW_HEADERS.length)) setupReviewSheetHeaders_(existingSheet);
    return existing;
  }
  const ss = SpreadsheetApp.create('單據審核 - ' + center.name);
  const sheet = ss.getSheets()[0]; // 全新建立的試算表只有一個分頁，這裡就是要幫它命名，不用查名字
  sheet.setName(REVIEW_SHEET_NAME);
  setupReviewSheetHeaders_(sheet);
  saveCenterReviewSheet_(center, ss.getId(), ss.getUrl());

  // 放進「中心審核表」資料夾（見 getReviewSheetsFolder_，有指定 ID 就用固定那個），方便集中管理
  try {
    DriveApp.getFileById(ss.getId()).moveTo(getReviewSheetsFolder_());
  } catch (e) {
    console.error('搬移審核表到資料夾失敗（不影響功能）：' + e);
  }
  return ss;
}

function applyCenterPermissions_(ss, center) {
  const sheet = getReviewSheet_(ss);

  // 0. 每次跑選單「①」都把標題列刷新成目前最新的完整欄位。
  //    真實踩過的坑：如果這份審核表是在某個「欄位比較少」的舊版程式碼部署期間被建立的，
  //    第 2 列已經有一部分（舊的、比較短的）標題、不是空的，getOrCreateCenterSpreadsheet_ 裡
  //    「只在整列空白才補標題」的防線就不會動它，導致後面新增的那幾欄永遠沒有標題。
  //    這裡在「①」流程無條件重寫標題列（只動第 2 列跟欄位格式，不碰第 3 列以後的資料），
  //    讓標題一定跟現在的 REVIEW_HEADERS 對齊。
  setupReviewSheetHeaders_(sheet);

  // 1. 分享給審核人（編輯者）。預覽測試模式不分享，免得寄共用通知給大家。
  (isPreviewMode_() ? [] : center.approverEmails).forEach(function (email) {
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
  // 系統帳號自己（執行這個選單的 service@）也排除：審核表放在共用雲端硬碟時沒有「擁有者」，
  // 上面那行排除不到它，選單①就會誤報「service@ 有編輯權但不在名單上」。
  let selfEmail = '';
  try {
    selfEmail = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    // 拿不到就算了，頂多多一行誤報
  }
  const stray = [];
  try {
    ss.getEditors().forEach(function (user) {
      const email = user.getEmail();
      const key = email.toLowerCase();
      if (key === ownerEmail || key === selfEmail || approvers[key]) return;
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
    formatDateTime_(record.uploadedAt), record.uploader, record.project, record.docType || DOC_TYPE_RECEIPT, record.invoiceDate,
    record.amount, record.quoteTotal || '', record.purpose, record.vendor,
    record.payStatus || '', record.payMethod || '', record.cardForm || '', record.repayTarget || '', record.payee || '', record.paymentDetail || '', record.confirmNote || '',
    record.linkedQuoteId || '', record.urgent ? '緊急' : '一般', record.expectedPayoutDate || '', fileUrl,
    '待審核', '', '', '', '', record.budgetItem || '', record.id,
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
    docType: row[MASTER_DOCTYPE_COL - 1] || DOC_TYPE_RECEIPT,
    invoiceDate: formatDateOnly_(row[MASTER_INVOICE_DATE_COL - 1]),
    amount: row[MASTER_AMOUNT_COL - 1],
    quoteTotal: row[MASTER_QUOTE_TOTAL_COL - 1],
    vendor: row[MASTER_VENDOR_COL - 1],
    purpose: row[MASTER_PURPOSE_COL - 1],
    budgetItem: row[MASTER_BUDGET_ITEM_COL - 1],
    payStatus: row[MASTER_PAYSTATUS_COL - 1],
    payMethod: row[MASTER_PAYMETHOD_COL - 1],
    cardForm: row[MASTER_CARDFORM_COL - 1],
    repayTarget: row[MASTER_REPAY_TARGET_COL - 1],
    payee: row[MASTER_PAYEE_COL - 1],
    paymentDetail: row[MASTER_PAYINFO_COL - 1],
    confirmNote: row[MASTER_CONFIRM_COL - 1],
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
      // 這是總表狀態/審核人/審核時間/退回原因這四欄唯一合法的寫入來源——人在審核表上操作後，
      // 靠這裡同步過去，總表本身永遠不會被其他程式直接動這四欄。
      const status = row[REVIEW_EDITABLE_START_COL - 1];
      const reviewer = row[REVIEW_REVIEWER_COL - 1];
      const note = row[REVIEW_NOTE_COL - 1];
      // 只要審核表跟總表現在存的不一樣就同步過去（不排除「待審核」，才不會漏掉「已核准被主管
      // 手動改回待審核」這種真實變化）；「待審核」狀態底下審核人/審核時間清空，因為這代表還沒有
      // 人真正審過，不該留著上一輪的審核人跟時間造成誤會。
      const statusChanged = status &&
        (masterData[MASTER_STATUS_COL - 1] !== status ||
         masterData[MASTER_REVIEWER_COL - 1] !== reviewer ||
         masterData[MASTER_REJECT_REASON_COL - 1] !== note);

      if (statusChanged) {
        const reviewedAt = status === '待審核' ? '' : formatDateTime_(new Date().toISOString());
        master.getRange(masterRow, MASTER_STATUS_COL, 1, 4).setValues([[status, reviewer, reviewedAt, note]]);
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
// 回傳 HTTP 狀態碼（200 = 成功；沒設定 webhook 回傳 null）。呼叫端目前都不看回傳值，失敗也不擋主流程。
// target：省略＝#組織布告欄（全體同仁）；'finance'＝#team-組織發展中心（財務內部，見 slackWebhookUrl_）
function postToSlack_(text, target) {
  if (isPreviewMode_()) return logSlackPreview_(text, target);
  const webhookUrl = slackWebhookUrl_(target);
  if (!webhookUrl) return null;
  const res = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
  // 送失敗時留紀錄（不印網址本身）：webhook 被撤銷、換錯網址時，到 Apps Script「執行項目」就看得到原因，不會無聲無息
  const code = res.getResponseCode();
  if (code !== 200) console.warn('Slack 通知送出失敗（HTTP ' + code + '）：' + String(res.getContentText()).slice(0, 200));
  return code;
}

// 預覽測試模式：訊息不送 Slack，寫進總表副本的「Slack預覽」分頁（最新的在最上面）
function logSlackPreview_(text, target) {
  try {
    const sheet = getOrCreateSheet_(SLACK_PREVIEW_SHEET_NAME,
      ['時間', '會發到哪個頻道', '訊息內容（預覽測試模式，不會真的發到 Slack）'], []);
    sheet.insertRowAfter(1);
    sheet.getRange(2, 1, 1, 3).setNumberFormat('@').setValues([[
      nowText_(), target === 'finance' ? '#team-組織發展中心' : '#組織布告欄', String(text),
    ]]);
  } catch (e) {
    console.warn('寫入 Slack預覽 分頁失敗：' + e);
  }
  return 200;
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
    '用途：' + (record.purpose || record.vendor || '—'),
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
    const purpose = rowData[REVIEW_PURPOSE_COL - 1];
    const vendor = rowData[REVIEW_VENDOR_COL - 1];
    const rejectReason = rowData[REVIEW_NOTE_COL - 1] || '（審核人未填寫原因）';

    const person = personByName_(uploader);
    const mention = (person && person.slackId) ? '<@' + person.slackId + '>' : (uploader || '（未知申請人）') + '（尚未設定 Slack ID，不會跳通知）';

    const lines = [
      '↩️ *您的單據被退回，請補件後重新上傳*　' + mention,
      '專案：' + projectName,
      '發票日期：' + (invoiceDate || '—') + '　金額：NT$ ' + (amount || 0),
      '用途：' + (purpose || vendor || '—'),
      '退回原因：' + rejectReason,
    ];
    postToSlack_(lines.join('\n'));
  } catch (err) {
    console.error('退件即時通知失敗：' + err);
  }
}

// 每月固定的審核日提醒：tag 各中心的審核人（不再用 <!channel> 吵到全體同仁），附上各中心審核表連結
// （審核表現在一個中心一份，列中心而不是列專案，不然同中心底下的專案會重複列出同一個連結）
function sendPendingDigestToSlack() {
  const approverEmails = [];
  activeCenters_().forEach(function (center) {
    center.approverEmails.forEach(function (email) {
      if (approverEmails.indexOf(email.toLowerCase()) === -1) approverEmails.push(email.toLowerCase());
    });
  });
  const mentions = approverEmails.map(mentionByEmail_).join(' ') || '各位主管';
  const lines = ['📋 ' + mentions + ' 今天是各位主管的審核日，請記得審核喔！', ''];
  activeCenters_().forEach(function (center) {
    const url = center.reviewSheetId ? (function () {
      try { return SpreadsheetApp.openById(center.reviewSheetId).getUrl(); } catch (e) { return ''; }
    })() : '';
    lines.push('• ' + center.name + (url ? ' → ' + url : '（尚未建立審核表，先執行選單「① 建立/更新設定與審核表」）'));
  });
  postToSlack_(lines.join('\n'));
}

/**
 * 付款完成通知（手動觸發，備用）。
 * 2026-10 起，20 號那批在網頁「財務作業」按「確認已付款」時會自動發這則（見 notifyPaid_）；
 * 這個選單留給「直接在總表填付款日期」的情況手動補發。格式跟自動發的一樣：依中心統計本月付款。
 */
function sendPaymentDigestToSlack() {
  const ui = SpreadsheetApp.getUi();
  const thisMonth = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const summary = monthlySummary_(thisMonth);
  if (summary.total === 0) {
    ui.alert('本月（' + thisMonth + '）還沒有任何已填付款日期的紀錄，未發送通知。');
    return;
  }
  postToSlack_(summary.text);
  ui.alert('已發送付款通知：本月共 ' + summary.total + ' 筆，合計 ' + fmtNt_(summary.totalAmount) + '。');
}

/* ============================================================
   共用小工具（財務作業、團隊後台用）
   ============================================================ */
const TZ = 'Asia/Taipei';

function nowText_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
}
function todayText_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}
// 儲存格內容一律轉成文字：Sheets 有時會把文字自動轉成 Date 物件，讀回來要轉回我們原本的格式
function cellText_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
  return String(v);
}
function parseYmd_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: Number(m[1]), m0: Number(m[2]) - 1, d: Number(m[3]) } : null;
}
// 用 UTC 做純日期加減（月份超過 12 會自動進位到下一年），不受伺服器時區影響
function ymd_(y, m0, d) {
  return Utilities.formatDate(new Date(Date.UTC(y, m0, d)), 'UTC', 'yyyy-MM-dd');
}
// 2026-11-05 → 11/5（Slack 訊息用）
function shortDate_(ymd) {
  const p = parseYmd_(ymd);
  return p ? (p.m0 + 1) + '/' + p.d : String(ymd || '');
}
function fmtNt_(n) {
  return 'NT$ ' + Math.round(Number(n) || 0).toLocaleString('en-US');
}
// Slack 訊息裡 & < > 有特殊意義，使用者打的文字要先跳脫
function slackEscape_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function slackLink_(url, text) {
  return '<' + url + '|' + slackEscape_(text) + '>';
}
// tag 一個人：人員設定有 Slack ID 就 tag（對方會跳通知），沒有就只寫名字
function mentionByEmail_(email) {
  const p = personByEmail_(email);
  if (p && p.slackId) return '<@' + p.slackId + '>';
  return slackEscape_(p ? p.name : (email || ''));
}
function mentionByName_(name) {
  const p = personByName_(name);
  if (p && p.slackId) return '<@' + p.slackId + '>';
  return slackEscape_(name || '');
}
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
// 一次把收支總表讀進來，並建一個「紀錄ID → 列」的索引
function readMasterTable_() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const rows = last >= 3 ? sheet.getRange(3, 1, last - 2, HEADERS.length).getValues() : [];
  const byId = {};
  rows.forEach(function (row, i) {
    const id = row[MASTER_RECORD_ID_COL - 1];
    if (id) byId[id] = { row: row, rowIndex: i + 3 };
  });
  return { sheet: sheet, rows: rows, byId: byId };
}
// 寫一格純文字（先設純文字格式，避免 Sheets 把日期、帳號自動轉格式）
function setMasterText_(sheet, rowIndex, col, value) {
  sheet.getRange(rowIndex, col).setNumberFormat('@').setValue(value === null || value === undefined ? '' : String(value));
}

/* ============================================================
   財務作業（2026-10 新增）：付款批次、放行、單據完備
   ============================================================
   會計 ① 選批次 → ② 核對清單 → ③ 匯入兆豐、送出放行請求（新增一筆「付款批次」，狀態＝待放行）
   放行人 在網頁「待放行」逐筆核對 → 確認放行（可以部分不放行，狀態＝已放行）或整批退回（狀態＝已退回）
   會計 ④ 確認已付款（寫總表付款日期、發 Slack，狀態＝已付款）→ ⑤ 記到藍途（狀態＝已完成）
   批次本身只記在總表的「付款批次」分頁；每筆單據的付款日期、付款批次、放行備註寫回收支總表。
   ⚠️ 薪資跟代墊款在兆豐是「同一筆轉帳」，所以放行人不能只把某筆代墊款標不放行就放行——
      要整批退回給會計，請會計先把那位同仁的金額改掉（見 financeRelease_）。 */

const BATCH_SHEET_NAME = '付款批次';
const BATCH_HEADERS = [
  '批次ID', '付款日', '類型', '狀態', '紀錄ID', '不放行（紀錄ID→原因）', '薪資總額', '合計金額',
  '送出人', '送出時間', '放行人', '放行時間', '退回原因', '實際匯出日期', '確認付款人', '確認付款時間', '完成人', '完成時間',
];
const BATCH_COL = {
  id: 1, payDate: 2, type: 3, status: 4, recordIds: 5, held: 6, salaryTotal: 7, total: 8,
  sentBy: 9, sentAt: 10, releasedBy: 11, releasedAt: 12, returnReason: 13,
  paidDate: 14, confirmedBy: 15, confirmedAt: 16, doneBy: 17, doneAt: 18,
};
const BATCH_STATUS_PENDING = '待放行';
const BATCH_STATUS_RELEASED = '已放行';
const BATCH_STATUS_RETURNED = '已退回';
const BATCH_STATUS_WITHDRAWN = '已撤回';
const BATCH_STATUS_PAID = '已付款';
const BATCH_STATUS_DONE = '已完成';
const BATCH_OPEN_STATUSES = [BATCH_STATUS_PENDING, BATCH_STATUS_RELEASED]; // 這兩種狀態的批次裡的單據，不能再被放進別的批次
const GROUP_ORDER = { reimb: 0, transfer: 1, bill: 2 };                     // 付款順序：代墊款 → 匯款 → 繳費單

function getBatchSheet_() {
  const ss = getMasterSpreadsheet_();
  let sheet = ss.getSheetByName(BATCH_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(BATCH_SHEET_NAME);
    if (sheet.getMaxColumns() < BATCH_HEADERS.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), BATCH_HEADERS.length - sheet.getMaxColumns());
    }
    sheet.getRange(1, 1, 1, BATCH_HEADERS.length).setValues([BATCH_HEADERS]);
    sheet.setFrozenRows(1);
    // 整張存成純文字：日期、時間、金額讀回來才會跟寫進去的一模一樣
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, BATCH_HEADERS.length).setNumberFormat('@');
  }
  return sheet;
}

function batchFromRow_(r, rowIndex) {
  const t = function (key) { return cellText_(r[BATCH_COL[key] - 1]).trim(); };
  let held = {};
  try {
    held = t('held') ? JSON.parse(t('held')) : {};
  } catch (e) {
    held = {};
  }
  return {
    rowIndex: rowIndex,
    id: t('id'), payDate: formatDateOnly_(t('payDate')), type: t('type'), status: t('status'),
    recordIds: t('recordIds').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    held: held && typeof held === 'object' ? held : {},
    salaryTotal: Number(t('salaryTotal')) || 0, total: Number(t('total')) || 0,
    sentBy: t('sentBy'), sentAt: t('sentAt'), releasedBy: t('releasedBy'), releasedAt: t('releasedAt'),
    returnReason: t('returnReason'), paidDate: formatDateOnly_(t('paidDate')),
    confirmedBy: t('confirmedBy'), confirmedAt: t('confirmedAt'), doneBy: t('doneBy'), doneAt: t('doneAt'),
  };
}

function readBatches_() {
  return readSheetRows_(getBatchSheet_(), BATCH_HEADERS.length)
    .map(function (r, i) { return batchFromRow_(r, i + 2); })
    .filter(function (b) { return b.id; });
}
function findBatch_(id) {
  const list = readBatches_();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function batchCellValue_(key, v) {
  if (key === 'held') return JSON.stringify(v || {});
  if (key === 'recordIds') return (v || []).join(',');
  return v === null || v === undefined ? '' : String(v);
}
function appendBatch_(fields) {
  const sheet = getBatchSheet_();
  const row = Math.max(sheet.getLastRow(), 1) + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 20);
  const values = BATCH_HEADERS.map(function () { return ''; });
  Object.keys(fields).forEach(function (key) { values[BATCH_COL[key] - 1] = batchCellValue_(key, fields[key]); });
  sheet.getRange(row, 1, 1, BATCH_HEADERS.length).setNumberFormat('@').setValues([values]);
  return batchFromRow_(values, row);
}
function updateBatch_(batch, fields) {
  const sheet = getBatchSheet_();
  Object.keys(fields).forEach(function (key) {
    sheet.getRange(batch.rowIndex, BATCH_COL[key]).setNumberFormat('@').setValue(batchCellValue_(key, fields[key]));
    batch[key] = fields[key];
  });
  return batch;
}
// 給網頁的批次資料：加上人名、筆數，拿掉內部用的列號
function batchForClient_(b) {
  return {
    id: b.id, payDate: b.payDate, type: b.type, status: b.status,
    count: b.recordIds.length, total: b.total, salaryTotal: b.salaryTotal,
    sentBy: b.sentBy, sentByName: b.sentBy ? approverDisplayName_(b.sentBy) : '', sentAt: b.sentAt,
    releasedBy: b.releasedBy, releasedByName: b.releasedBy ? approverDisplayName_(b.releasedBy) : '', releasedAt: b.releasedAt,
    returnReason: b.returnReason, held: b.held, heldCount: Object.keys(b.held || {}).length,
    paidDate: b.paidDate, confirmedBy: b.confirmedBy, confirmedByName: b.confirmedBy ? approverDisplayName_(b.confirmedBy) : '',
    confirmedAt: b.confirmedAt, doneAt: b.doneAt, recordIds: b.recordIds,
  };
}

function batchTypeOf_(payDate) {
  const p = parseYmd_(payDate);
  if (p && p.d === 5) return '5號';
  if (p && p.d === 20) return '20號';
  return '臨時';
}
// 今天之後（含今天）最近的 5 號、20 號
function upcomingPayDates_(todayYmd) {
  const t = parseYmd_(todayYmd);
  const c5 = t.d <= 5 ? ymd_(t.y, t.m0, 5) : ymd_(t.y, t.m0 + 1, 5);
  const c20 = t.d <= 20 ? ymd_(t.y, t.m0, 20) : ymd_(t.y, t.m0 + 1, 20);
  return [c5, c20].sort();
}
// 某個日期當天或之前最近的付款日（5 號或 20 號），繳費單用：要在繳費期限前付掉
function latestPayDayOnOrBefore_(ymd) {
  const p = parseYmd_(ymd);
  if (!p) return '';
  if (p.d >= 20) return ymd_(p.y, p.m0, 20);
  if (p.d >= 5) return ymd_(p.y, p.m0, 5);
  return ymd_(p.y, p.m0 - 1, 20);
}

function paymentGroupOf_(payMethod, repayTarget) {
  if (payMethod === PAY_METHOD_BILL) return 'bill';
  if (payMethod === PAY_METHOD_TRANSFER) return repayTarget === REPAY_TARGET_MEMBER ? 'reimb' : 'transfer';
  return '';
}

// 會計科目名稱 → 藍途 4 位數代碼（「會計科目設定」B 欄）
function loadGlCodeMap_() {
  const sheet = getOrCreateSheet_(GLCODE_SHEET_NAME, GLCODE_HEADERS, []);
  const map = {};
  readSheetRows_(sheet, GLCODE_HEADERS.length).forEach(function (r) {
    const name = String(r[0] || '').trim();
    if (name) map[name] = String(r[1] || '').replace(/\D/g, '');
  });
  return map;
}

// 一列總表 → 財務作業用的單據資料（含完整帳號，只回給有財務角色的人）
function financeRecord_(row, glMap) {
  const raw = function (col) { return row[col - 1]; };
  const s = function (col) { return cellText_(raw(col)).trim(); };
  const project = findProject_(s(MASTER_PROJECT_COL));
  const payMethod = s(MASTER_PAYMETHOD_COL);
  const repayTarget = s(MASTER_REPAY_TARGET_COL);
  const group = paymentGroupOf_(payMethod, repayTarget);
  const glCode = s(MASTER_GLCODE_COL);
  const fileUrl = s(MASTER_FILE_URL_COL);
  const branch = s(MASTER_PAYEE_BRANCH_COL).replace(/\D/g, '');
  const account = s(MASTER_PAYEE_ACCOUNT_COL).replace(/\D/g, '');
  const completeRaw = raw(MASTER_COMPLETE_COL);
  return {
    id: s(MASTER_RECORD_ID_COL),
    group: group,
    uploader: s(MASTER_UPLOADER_COL),
    person: group === 'reimb' ? s(MASTER_PAYEE_COL) : '',
    payee: s(MASTER_PAYEE_COL) || s(MASTER_PAYEE_ACCOUNT_NAME_COL) || s(MASTER_VENDOR_COL),
    project: s(MASTER_PROJECT_COL),
    center: project ? project.center : '',
    vendor: s(MASTER_VENDOR_COL),
    purpose: s(MASTER_PURPOSE_COL),
    budgetItem: s(MASTER_BUDGET_ITEM_COL),
    glCode: glCode,
    glCodeNexTrek: glCode && glMap ? (glMap[glCode] || '') : '',
    amount: Number(raw(MASTER_AMOUNT_COL)) || 0,
    invoiceDate: formatDateOnly_(raw(MASTER_INVOICE_DATE_COL)),
    invoiceNumber: s(MASTER_INVOICE_NO_COL),
    docType: s(MASTER_DOCTYPE_COL) || DOC_TYPE_RECEIPT,
    payStatus: s(MASTER_PAYSTATUS_COL),
    payMethod: payMethod,
    repayTarget: repayTarget,
    accountName: s(MASTER_PAYEE_ACCOUNT_NAME_COL),
    bankName: s(MASTER_PAYEE_BANK_COL),
    branch: branch,
    account: account,
    paymentDetail: s(MASTER_PAYINFO_COL),
    billDueDate: formatDateOnly_(raw(MASTER_BILL_DUE_COL)),
    fixedExpense: s(MASTER_FIXED_EXPENSE_COL) === '是',
    urgent: s(MASTER_URGENCY_COL) === '緊急',
    expectedPayoutDate: formatDateOnly_(raw(MASTER_EXPECTED_PAYOUT_COL)),
    uploadedAt: s(MASTER_UPLOAD_TIME_COL),
    status: s(MASTER_STATUS_COL),
    reviewer: s(MASTER_REVIEWER_COL),
    reviewedAt: s(MASTER_REVIEWED_AT_COL),
    complete: completeRaw === true || String(completeRaw).toUpperCase() === 'TRUE' || completeRaw === '是',
    paidAt: formatDateOnly_(raw(MASTER_PAYDATE_COL)),
    batchId: s(MASTER_BATCH_ID_COL),
    releaseNote: s(MASTER_RELEASE_NOTE_COL),
    paperNote: s(MASTER_PAPER_NOTE_COL),
    fileName: s(MASTER_FILE_NAME_COL),
    fileUrl: fileUrl,
    hasFile: !!fileIdFromUrl_(fileUrl),
    legacy: group === 'transfer' && !(branch && account), // 舊格式：帳號只是一段自由文字
    firstTime: false,                                      // 由 candidateRecords_ 依付款紀錄補上
  };
}

// 預計撥款日：上傳時算好存在總表；舊資料沒有就用同一套規則現算（規則同前端 computeExpectedPayoutDate）
function expectedPayoutOf_(rec) {
  if (rec.expectedPayoutDate) return rec.expectedPayoutDate;
  const up = parseYmd_(rec.uploadedAt);
  if (!up) return '';
  if (rec.group === 'reimb') return ymd_(up.y, up.m0 + (up.d <= 9 ? 1 : 2), 5);
  if (rec.group === 'bill' && rec.billDueDate) return latestPayDayOnOrBefore_(rec.billDueDate) || rec.billDueDate;
  return ymd_(up.y, up.m0 + (up.d <= 9 ? 0 : 1), 20);
}

function paymentOrderCompare_(a, b) {
  const g = (GROUP_ORDER[a.group] || 0) - (GROUP_ORDER[b.group] || 0);
  if (g) return g;
  if (a.group === 'reimb' && a.person !== b.person) return a.person < b.person ? -1 : 1;
  if (a.expectedPayoutDate !== b.expectedPayoutDate) return a.expectedPayoutDate < b.expectedPayoutDate ? -1 : 1;
  return a.uploadedAt < b.uploadedAt ? -1 : (a.uploadedAt > b.uploadedAt ? 1 : 0);
}

// 這個付款日可以付的單據：已核准、還沒付款、要匯款或代繳、預計撥款日在付款日當天或之前、不在其他進行中的批次裡
function candidateRecords_(table, batches, payDate, glMap) {
  const inOpenBatch = {};
  batches.forEach(function (b) {
    if (BATCH_OPEN_STATUSES.indexOf(b.status) === -1) return;
    b.recordIds.forEach(function (id) { inOpenBatch[id] = b.id; });
  });
  const all = table.rows.map(function (row) { return financeRecord_(row, glMap); }).filter(function (r) { return r.id; });
  const paidAccounts = {};
  all.forEach(function (r) { if (r.paidAt && r.account) paidAccounts[r.account] = true; });
  return all
    .filter(function (r) {
      return r.status === STATUS_OPTIONS[1] && !r.paidAt && r.payStatus === PAY_STATUS_UNPAID && r.group && !inOpenBatch[r.id];
    })
    .map(function (r) {
      r.expectedPayoutDate = expectedPayoutOf_(r);
      r.firstTime = r.group === 'transfer' && !!r.account && !paidAccounts[r.account];
      return r;
    })
    .filter(function (r) { return !r.expectedPayoutDate || r.expectedPayoutDate <= payDate; })
    .sort(paymentOrderCompare_);
}

function groupTotals_(records) {
  const out = { reimb: { count: 0, total: 0 }, transfer: { count: 0, total: 0 }, bill: { count: 0, total: 0 } };
  records.forEach(function (r) {
    if (!out[r.group]) return;
    out[r.group].count++;
    out[r.group].total += r.amount;
  });
  return out;
}
function sumAmount_(records) {
  return records.reduce(function (t, r) { return t + (Number(r.amount) || 0); }, 0);
}

function requireFinanceRole_(auth, role) {
  if ((auth.financeRoles || []).indexOf(role) === -1) {
    throw new Error('這個動作需要「' + role + '」的財務角色（總表「人員設定」的「財務角色」欄）。');
  }
}

function handleFinanceAction_(body, auth) {
  if (!(auth.financeRoles || []).length) {
    return { ok: false, error: '你沒有財務作業的權限。需要的話，請管理員在總表「人員設定」的「財務角色」欄幫你填上「會計」或「放行」。' };
  }
  try {
    switch (body.action) {
      case 'financeOverview': return financeOverview_();
      case 'financeCandidates': return financeCandidates_(body);
      case 'financeSendRelease':
        requireFinanceRole_(auth, FINANCE_ROLE_ACCOUNTANT);
        return financeSendRelease_(auth, body);
      case 'financeWithdraw':
        requireFinanceRole_(auth, FINANCE_ROLE_ACCOUNTANT);
        return financeWithdraw_(auth, body);
      case 'financeGetBatch': return financeGetBatch_(body);
      case 'financeRelease':
        requireFinanceRole_(auth, FINANCE_ROLE_RELEASER);
        return financeRelease_(auth, body);
      case 'financeReturn':
        requireFinanceRole_(auth, FINANCE_ROLE_RELEASER);
        return financeReturn_(auth, body);
      case 'financeConfirmPaid':
        requireFinanceRole_(auth, FINANCE_ROLE_ACCOUNTANT);
        return financeConfirmPaid_(auth, body);
      case 'financeFile': return financeFile_(body);
      case 'financeCompleteBatch':
        requireFinanceRole_(auth, FINANCE_ROLE_ACCOUNTANT);
        return financeCompleteBatch_(auth, body);
      case 'financeCompleteness': return financeCompleteness_();
      case 'financeMarkPaper': return financeMarkPaper_(auth, body);
      default: return { ok: false, error: 'unknown action: ' + body.action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function financeOverview_() {
  const table = readMasterTable_();
  const batches = readBatches_();
  const glMap = loadGlCodeMap_();
  const today = todayText_();
  const suggestions = upcomingPayDates_(today).map(function (payDate) {
    const recs = candidateRecords_(table, batches, payDate, glMap);
    return { payDate: payDate, type: batchTypeOf_(payDate), count: recs.length, total: sumAmount_(recs), groups: groupTotals_(recs) };
  });
  const newestFirst = batches.slice().sort(function (a, b) { return a.id < b.id ? 1 : -1; });
  const active = newestFirst.filter(function (b) {
    return [BATCH_STATUS_PENDING, BATCH_STATUS_RELEASED, BATCH_STATUS_PAID].indexOf(b.status) !== -1;
  });
  const recent = newestFirst.filter(function (b) { return active.indexOf(b) === -1; }).slice(0, 10);
  return {
    ok: true, today: today, suggestions: suggestions,
    activeBatches: active.map(batchForClient_), recentBatches: recent.map(batchForClient_),
  };
}

function financeCandidates_(body) {
  const payDate = String(body.payDate || '');
  if (!parseYmd_(payDate)) throw new Error('付款日格式不對（要 yyyy-MM-dd）');
  const table = readMasterTable_();
  const batches = readBatches_();
  const records = candidateRecords_(table, batches, payDate, loadGlCodeMap_());
  const returned = batches
    .filter(function (b) { return b.payDate === payDate && b.status === BATCH_STATUS_RETURNED; })
    .sort(function (a, b) { return a.id < b.id ? 1 : -1; })[0];
  return {
    ok: true, payDate: payDate, type: batchTypeOf_(payDate), records: records,
    lastReturned: returned ? batchForClient_(returned) : null,
  };
}

function financeSendRelease_(auth, body) {
  const payDate = String(body.payDate || '');
  if (!parseYmd_(payDate)) throw new Error('付款日格式不對（要 yyyy-MM-dd）');
  const ids = (Array.isArray(body.recordIds) ? body.recordIds : []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('沒有勾選任何單據。');
  if (ids.length !== Object.keys(ids.reduce(function (o, id) { o[id] = 1; return o; }, {})).length) throw new Error('清單裡有重複的單據。');
  const salaryTotal = Math.max(0, Math.round(Number(body.salaryTotal) || 0));
  return withScriptLock_(function () {
    const table = readMasterTable_();
    const batches = readBatches_();
    const allowed = {};
    candidateRecords_(table, batches, payDate, loadGlCodeMap_()).forEach(function (r) { allowed[r.id] = r; });
    const bad = ids.filter(function (id) { return !allowed[id]; });
    if (bad.length) {
      throw new Error('有 ' + bad.length + ' 筆單據現在不能付款（可能剛被退回、已經付款，或已經在別的批次裡）。請重新整理清單再送一次。');
    }
    const records = ids.map(function (id) { return allowed[id]; });
    // 批次ID＝B＋付款日＋送出時間；同一秒內又送一次（例如撤回後馬上重送）就在後面加 -2、-3，確保不重複
    const baseId = 'B' + payDate.replace(/-/g, '') + '-' + Utilities.formatDate(new Date(), TZ, 'HHmmss');
    let batchId = baseId;
    for (let n = 2; batches.some(function (b) { return b.id === batchId; }); n++) batchId = baseId + '-' + n;
    const batch = appendBatch_({
      id: batchId,
      payDate: payDate, type: batchTypeOf_(payDate), status: BATCH_STATUS_PENDING,
      recordIds: ids, held: {}, salaryTotal: salaryTotal, total: sumAmount_(records),
      sentBy: auth.email, sentAt: nowText_(),
    });
    try {
      notifyReleaseRequest_(batch, records);
    } catch (err) {
      console.error('放行請求 Slack 通知失敗：' + err);
    }
    return { ok: true, batch: batchForClient_(batch) };
  });
}

function financeWithdraw_(auth, body) {
  return withScriptLock_(function () {
    const batch = findBatch_(String(body.batchId || ''));
    if (!batch) throw new Error('找不到這一批。');
    if (batch.status !== BATCH_STATUS_PENDING) throw new Error('這一批目前是「' + batch.status + '」，只有「待放行」的批次可以撤回。');
    updateBatch_(batch, { status: BATCH_STATUS_WITHDRAWN });
    try {
      postToSlack_(
        '↩️ ' + slackEscape_(approverDisplayName_(auth.email)) + ' 撤回了 ' + shortDate_(batch.payDate) + ' 付款批次的放行請求（' +
        batch.recordIds.length + ' 筆，' + fmtNt_(batch.total) + '），這一批不用放行了。',
        'finance'
      );
    } catch (err) {
      console.error('撤回通知失敗：' + err);
    }
    return { ok: true, batch: batchForClient_(batch) };
  });
}

function batchRecords_(batch, table, glMap) {
  return batch.recordIds
    .map(function (id) { return table.byId[id] ? financeRecord_(table.byId[id].row, glMap) : null; })
    .filter(Boolean);
}

function financeGetBatch_(body) {
  const batch = findBatch_(String(body.batchId || ''));
  if (!batch) throw new Error('找不到這一批。');
  const records = batchRecords_(batch, readMasterTable_(), loadGlCodeMap_());
  return { ok: true, batch: batchForClient_(batch), records: records };
}

// 放行人送來的「不放行」清單：每一筆都要在這一批裡、而且要寫原因
function cleanHeld_(held, batch) {
  const out = {};
  const src = held && typeof held === 'object' ? held : {};
  Object.keys(src).forEach(function (id) {
    if (batch.recordIds.indexOf(id) === -1) throw new Error('不放行的單據不在這一批裡，請重新整理後再試。');
    const reason = String(src[id] || '').trim().slice(0, 200);
    if (!reason) throw new Error('每一筆不放行的單據都要寫原因。');
    out[id] = reason;
  });
  return out;
}
function writeReleaseNotes_(table, held) {
  const today = todayText_();
  Object.keys(held).forEach(function (id) {
    const entry = table.byId[id];
    if (entry) setMasterText_(table.sheet, entry.rowIndex, MASTER_RELEASE_NOTE_COL, today + ' 不放行：' + held[id]);
  });
}

function financeRelease_(auth, body) {
  return withScriptLock_(function () {
    const batch = findBatch_(String(body.batchId || ''));
    if (!batch) throw new Error('找不到這一批。');
    if (batch.status !== BATCH_STATUS_PENDING) throw new Error('這一批目前是「' + batch.status + '」，不能放行。');
    if (batch.sentBy && batch.sentBy.toLowerCase() === String(auth.email).toLowerCase()) {
      throw new Error('這一批是你自己送出的，要由另一位放行人放行（跟兆豐網銀的雙人控管一樣）。');
    }
    const held = cleanHeld_(body.held, batch);
    const table = readMasterTable_();
    const records = batchRecords_(batch, table, loadGlCodeMap_());
    const heldReimb = records.filter(function (r) { return held[r.id] && r.group === 'reimb'; });
    if (heldReimb.length) {
      throw new Error('代墊款跟薪資在兆豐是同一筆轉帳。不放行代墊款，要先請會計把那位同仁的金額改掉：請用「整批退回給會計」，這筆會排到下一循環。');
    }
    updateBatch_(batch, { status: BATCH_STATUS_RELEASED, held: held, releasedBy: auth.email, releasedAt: nowText_() });
    writeReleaseNotes_(table, held);
    try {
      notifyReleased_(batch, records, held, auth.email);
      if (Object.keys(held).length) notifyHeldToUploaders_(batch, records, held);
    } catch (err) {
      console.error('放行 Slack 通知失敗：' + err);
    }
    return { ok: true, batch: batchForClient_(batch) };
  });
}

function financeReturn_(auth, body) {
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (!reason) throw new Error('請寫退回的原因，會計才知道要改什麼。');
  return withScriptLock_(function () {
    const batch = findBatch_(String(body.batchId || ''));
    if (!batch) throw new Error('找不到這一批。');
    if (batch.status !== BATCH_STATUS_PENDING) throw new Error('這一批目前是「' + batch.status + '」，不能退回。');
    const held = cleanHeld_(body.held, batch);
    const table = readMasterTable_();
    const records = batchRecords_(batch, table, loadGlCodeMap_());
    updateBatch_(batch, {
      status: BATCH_STATUS_RETURNED, held: held, returnReason: reason, releasedBy: auth.email, releasedAt: nowText_(),
    });
    writeReleaseNotes_(table, held);
    try {
      notifyReturned_(batch, records, held, auth.email);
    } catch (err) {
      console.error('退回 Slack 通知失敗：' + err);
    }
    return { ok: true, batch: batchForClient_(batch) };
  });
}

function financeConfirmPaid_(auth, body) {
  const paidDate = String(body.paidDate || '');
  if (!parseYmd_(paidDate)) throw new Error('實際匯出日期格式不對（要 yyyy-MM-dd）。');
  return withScriptLock_(function () {
    const batch = findBatch_(String(body.batchId || ''));
    if (!batch) throw new Error('找不到這一批。');
    if (batch.status !== BATCH_STATUS_RELEASED) {
      throw new Error('這一批目前是「' + batch.status + '」。要等放行人在網頁上按了「確認放行」，才能確認已付款。');
    }
    const table = readMasterTable_();
    const glMap = loadGlCodeMap_();
    const warnings = [];
    const paid = [];
    batch.recordIds.forEach(function (id) {
      if (batch.held[id]) return;
      const entry = table.byId[id];
      if (!entry) {
        warnings.push('紀錄 ' + id + ' 在總表找不到了，略過。');
        return;
      }
      const rec = financeRecord_(entry.row, glMap);
      if (rec.paidAt) {
        warnings.push(rec.payee + '｜' + rec.purpose + ' 總表上已經有付款日期（' + rec.paidAt + '），沒有覆蓋。');
        return;
      }
      setMasterText_(table.sheet, entry.rowIndex, MASTER_PAYDATE_COL, paidDate);
      setMasterText_(table.sheet, entry.rowIndex, MASTER_BATCH_ID_COL, batch.id);
      setMasterText_(table.sheet, entry.rowIndex, MASTER_RELEASE_NOTE_COL, '');
      rec.paidAt = paidDate;
      paid.push(rec);
    });
    updateBatch_(batch, { status: BATCH_STATUS_PAID, paidDate: paidDate, confirmedBy: auth.email, confirmedAt: nowText_() });
    try {
      syncRowsToReviewSheets_(paid.map(function (r) { return r.id; }));
    } catch (err) {
      warnings.push('付款日期同步到中心審核表失敗，今晚的自動同步會再補上。（' + err + '）');
    }
    let posted = [];
    try {
      posted = notifyPaid_(batch, paid, paidDate);
    } catch (err) {
      warnings.push('Slack 通知送出失敗：' + err);
    }
    return { ok: true, batch: batchForClient_(batch), posted: posted, warnings: warnings };
  });
}

function financeFile_(body) {
  const batch = findBatch_(String(body.batchId || ''));
  if (!batch) throw new Error('找不到這一批。');
  const recordId = String(body.recordId || '');
  if (batch.recordIds.indexOf(recordId) === -1) throw new Error('這筆單據不在這一批裡。');
  const entry = readMasterTable_().byId[recordId];
  if (!entry) throw new Error('總表找不到這筆單據。');
  const fileId = fileIdFromUrl_(entry.row[MASTER_FILE_URL_COL - 1]);
  if (!fileId) throw new Error('這筆單據沒有憑證檔案。');
  const file = DriveApp.getFileById(fileId);
  const size = file.getSize();
  if (size > 20 * 1024 * 1024) {
    throw new Error('「' + file.getName() + '」有 ' + Math.round(size / 1024 / 1024) + ' MB，太大了，請到雲端硬碟手動下載。');
  }
  const blob = file.getBlob();
  return { ok: true, name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()), size: size };
}

function financeCompleteBatch_(auth, body) {
  return withScriptLock_(function () {
    const batch = findBatch_(String(body.batchId || ''));
    if (!batch) throw new Error('找不到這一批。');
    if (batch.status !== BATCH_STATUS_PAID) throw new Error('這一批目前是「' + batch.status + '」，要先確認已付款，才能完成。');
    updateBatch_(batch, { status: BATCH_STATUS_DONE, doneBy: auth.email, doneAt: nowText_() });
    return { ok: true, batch: batchForClient_(batch) };
  });
}

function completenessRecord_(rec) {
  return {
    id: rec.id, uploader: rec.uploader, center: rec.center, project: rec.project, vendor: rec.vendor, purpose: rec.purpose,
    amount: rec.amount, invoiceDate: rec.invoiceDate, invoiceNumber: rec.invoiceNumber, reviewer: rec.reviewer,
    reviewedAt: rec.reviewedAt, complete: rec.complete, paperNote: rec.paperNote, fileUrl: rec.fileUrl,
    fileName: rec.fileName, hasFile: rec.hasFile,
  };
}

// 單據完備：主管核准、有單據的。還沒核對的全部列出；已核對的只列最近 90 天（不然會越積越長）
function financeCompleteness_() {
  const table = readMasterTable_();
  const glMap = loadGlCodeMap_();
  const cutoff = Utilities.formatDate(new Date(Date.now() - 90 * 24 * 3600 * 1000), TZ, 'yyyy-MM-dd');
  const records = table.rows
    .map(function (row) { return financeRecord_(row, glMap); })
    .filter(function (r) { return r.id && r.status === STATUS_OPTIONS[1] && r.docType !== DOC_TYPE_NONE; })
    .filter(function (r) { return !r.complete || String(r.reviewedAt).slice(0, 10) >= cutoff; })
    .sort(function (a, b) {
      if (a.complete !== b.complete) return a.complete ? 1 : -1;
      return a.complete ? (a.reviewedAt < b.reviewedAt ? 1 : -1) : (a.reviewedAt < b.reviewedAt ? -1 : 1);
    })
    .map(completenessRecord_);
  return { ok: true, records: records };
}

function financeMarkPaper_(auth, body) {
  const result = String(body.result || '');
  if (['ok', 'issue', 'undo'].indexOf(result) === -1) throw new Error('不認得的核對結果：' + result);
  const note = String(body.note || '').trim().slice(0, 300);
  if (result === 'issue' && !note) throw new Error('請寫下哪裡有問題，上傳人才知道要補什麼。');
  return withScriptLock_(function () {
    const table = readMasterTable_();
    const entry = table.byId[String(body.recordId || '')];
    if (!entry) throw new Error('總表找不到這筆單據。');
    const sheet = table.sheet;
    const completeCell = sheet.getRange(entry.rowIndex, MASTER_COMPLETE_COL);
    setCompleteCheckbox_(sheet, entry.rowIndex, MASTER_COMPLETE_COL);
    if (result === 'ok') {
      completeCell.setValue(true);
      setMasterText_(sheet, entry.rowIndex, MASTER_PAPER_NOTE_COL, '');
    } else if (result === 'issue') {
      completeCell.setValue(false);
      setMasterText_(sheet, entry.rowIndex, MASTER_PAPER_NOTE_COL, todayText_() + '：' + note);
    } else {
      completeCell.setValue(false);
      setMasterText_(sheet, entry.rowIndex, MASTER_PAPER_NOTE_COL, '');
    }
    const fresh = sheet.getRange(entry.rowIndex, 1, 1, HEADERS.length).getValues()[0];
    const rec = financeRecord_(fresh, null);
    try {
      syncRowsToReviewSheets_([rec.id]);
    } catch (err) {
      console.error('單據完備同步到審核表失敗（今晚的自動同步會再補）：' + err);
    }
    if (result === 'issue') {
      try {
        postToSlack_([
          '📎 ' + mentionByName_(rec.uploader) + ' 你上傳的單據，會計核對紙本時發現問題，請補件：',
          '• ' + slackEscape_(rec.vendor || rec.purpose) + '｜' + fmtNt_(rec.amount) + '｜單據日期 ' + (rec.invoiceDate || '—'),
          '問題：' + slackEscape_(note),
          '請把正確的紙本交給會計，或跟會計確認怎麼補。',
        ].join('\n'));
      } catch (err) {
        console.error('補件通知失敗：' + err);
      }
    }
    return { ok: true, record: completenessRecord_(rec) };
  });
}

// 把總表的「付款日期」「單據完備」寫到對應中心審核表的那幾列（財務作業按下去之後馬上看得到，不用等晚上的同步）
function syncRowsToReviewSheets_(recordIds) {
  if (!recordIds || !recordIds.length) return;
  const table = readMasterTable_();
  const byCenter = {};
  recordIds.forEach(function (id) {
    const entry = table.byId[id];
    if (!entry) return;
    const center = centerOfProject_(entry.row[MASTER_PROJECT_COL - 1]);
    if (!center || !center.reviewSheetId) return;
    if (!byCenter[center.name]) byCenter[center.name] = { center: center, ids: {} };
    byCenter[center.name].ids[id] = entry.row;
  });
  Object.keys(byCenter).forEach(function (name) {
    const info = byCenter[name];
    const sheet = getReviewSheet_(SpreadsheetApp.openById(info.center.reviewSheetId));
    const last = sheet.getLastRow();
    if (last < 3) return;
    const ids = sheet.getRange(3, REVIEW_RECORD_ID_COL, last - 2, 1).getValues();
    ids.forEach(function (r, i) {
      const row = info.ids[r[0]];
      if (!row) return;
      const rowIndex = i + 3;
      sheet.getRange(rowIndex, REVIEW_PAYDATE_COL).setNumberFormat('@').setValue(formatDateOnly_(row[MASTER_PAYDATE_COL - 1]));
      setCompleteCheckbox_(sheet, rowIndex, REVIEW_COMPLETE_COL);
      sheet.getRange(rowIndex, REVIEW_COMPLETE_COL).setValue(row[MASTER_COMPLETE_COL - 1] === true);
    });
  });
}

/* ---------- 財務作業的 Slack 訊息（格式見示意版「Slack 通知格式」）---------- */
function releaserMentions_(exceptEmail) {
  const list = loadConfig_().people.filter(function (p) {
    return p.financeRoles.indexOf(FINANCE_ROLE_RELEASER) !== -1 && p.email.toLowerCase() !== String(exceptEmail || '').toLowerCase();
  });
  if (!list.length) return '（還沒有設定放行人：請到總表「人員設定」的「財務角色」填「放行」）';
  return list.map(function (p) { return p.slackId ? '<@' + p.slackId + '>' : slackEscape_(p.name); }).join(' ');
}
function peopleOrder_(records) {
  const names = [];
  records.forEach(function (r) { if (names.indexOf(r.person) === -1) names.push(r.person); });
  return names;
}

function notifyReleaseRequest_(batch, records) {
  const reimb = records.filter(function (r) { return r.group === 'reimb'; });
  const transfer = records.filter(function (r) { return r.group === 'transfer'; });
  const bill = records.filter(function (r) { return r.group === 'bill'; });
  const lines = [releaserMentions_(batch.sentBy) + ' ' + shortDate_(batch.payDate) + ' 付款批次已在兆豐建檔，請到團隊後台核對後放行'];
  if (batch.salaryTotal) lines.push('• 薪資：' + fmtNt_(batch.salaryTotal) + '（Swingvy 總額，不列個人金額）');
  if (reimb.length) {
    const people = peopleOrder_(reimb);
    lines.push('• 代墊款：' + people.length + ' 人、' + reimb.length + ' 筆，' + fmtNt_(sumAmount_(reimb)));
    people.forEach(function (name) {
      const mine = reimb.filter(function (r) { return r.person === name; });
      lines.push('　－ ' + slackEscape_(name) + ' ' + mine.length + ' 筆 ' + fmtNt_(sumAmount_(mine)));
    });
  }
  if (transfer.length) lines.push('• 匯款給廠商／外部個人：' + transfer.length + ' 筆，' + fmtNt_(sumAmount_(transfer)));
  if (bill.length) lines.push('• 網銀代繳（繳費單）：' + bill.length + ' 筆，' + fmtNt_(sumAmount_(bill)));
  lines.push('→ ' + slackLink_(appUrl_() + '#finance/ops/release/' + batch.id, '核對並放行：團隊後台「核銷作業 › 財務作業 › 待放行」'));
  postToSlack_(lines.join('\n'), 'finance');
}

function heldLines_(records, held) {
  return records.filter(function (r) { return held[r.id]; }).map(function (r) {
    return '　－ ' + slackEscape_(r.payee || r.vendor) + '｜' + slackEscape_(r.purpose) + '｜' + fmtNt_(r.amount) + '　原因：' + slackEscape_(held[r.id]);
  });
}

function notifyReleased_(batch, records, held, releaserEmail) {
  const paid = records.filter(function (r) { return !held[r.id]; });
  const heldCount = Object.keys(held).length;
  const lines = [
    '✅ ' + mentionByEmail_(batch.sentBy) + ' ' + slackEscape_(approverDisplayName_(releaserEmail)) + ' 已放行 ' +
    shortDate_(batch.payDate) + ' 付款批次：' + paid.length + ' 筆' + (batch.salaryTotal ? '＋薪資' : '') +
    '，合計 ' + fmtNt_(sumAmount_(paid) + batch.salaryTotal),
  ];
  if (heldCount) {
    lines.push('• 不放行 ' + heldCount + ' 筆，已移出這批（下一批會再列出）：');
    heldLines_(records, held).forEach(function (l) { lines.push(l); });
  }
  lines.push('請到兆豐確認交易都成功，再做第 4 步「確認已付款」 → ' + slackLink_(appUrl_() + '#finance/ops/batch/' + batch.id, '打開這一批'));
  postToSlack_(lines.join('\n'), 'finance');
}

function notifyReturned_(batch, records, held, releaserEmail) {
  const lines = [
    '↩️ ' + mentionByEmail_(batch.sentBy) + ' ' + slackEscape_(approverDisplayName_(releaserEmail)) + ' 把 ' +
    shortDate_(batch.payDate) + ' 付款批次退回了',
    '原因：' + slackEscape_(batch.returnReason),
  ];
  if (Object.keys(held).length) {
    lines.push('其中這幾筆這次先不付（回到清單時會先取消勾選）：');
    heldLines_(records, held).forEach(function (l) { lines.push(l); });
  }
  lines.push('這一批已經回到第 2 步「核對清單」，改好再送出放行請求 → ' + slackLink_(appUrl_() + '#finance/ops/batches', '打開付款批次'));
  postToSlack_(lines.join('\n'), 'finance');
}

// 不放行的單據：在布告欄 tag 上傳人說明原因（跟主管退件用同一個頻道）
function notifyHeldToUploaders_(batch, records, held) {
  const lines = ['↩️ 下面這幾筆 ' + shortDate_(batch.payDate) + ' 這批沒有付款，處理好之後會排進下一批：'];
  records.filter(function (r) { return held[r.id]; }).forEach(function (r) {
    lines.push('• ' + mentionByName_(r.uploader) + ' ' + slackEscape_(r.payee || r.vendor) + '｜' + slackEscape_(r.purpose) +
      '｜' + fmtNt_(r.amount) + '　原因：' + slackEscape_(held[r.id]));
  });
  lines.push('進度請到 ' + slackLink_(appUrl_() + '#finance/mine', '團隊後台「上傳紀錄」') + ' 查看。');
  postToSlack_(lines.join('\n'));
}

// 確認已付款後的通知：代墊款已匯出、廠商款已匯出；20 號那批另外發月付款總結
function notifyPaid_(batch, paid, paidDate) {
  const posted = [];
  const short = shortDate_(paidDate);
  const recordsLink = '明細請到 ' + slackLink_(appUrl_() + '#finance/mine', '團隊後台「上傳紀錄」') + ' 查看';
  const reimb = paid.filter(function (r) { return r.group === 'reimb'; });
  if (reimb.length) {
    const people = peopleOrder_(reimb);
    const lines = ['✅ ' + short + ' 代墊款已匯出：' + people.length + ' 人、' + reimb.length + ' 筆，合計 ' + fmtNt_(sumAmount_(reimb))];
    people.forEach(function (name) {
      const mine = reimb.filter(function (r) { return r.person === name; });
      lines.push('• ' + mentionByName_(name) + '　' + mine.length + ' 筆　' + fmtNt_(sumAmount_(mine)));
    });
    lines.push(recordsLink);
    postToSlack_(lines.join('\n'));
    posted.push('代墊款已匯出');
  }
  const ext = paid.filter(function (r) { return r.group !== 'reimb'; });
  if (ext.length) {
    const lines = ['✅ ' + short + ' 廠商款已匯出：' + ext.length + ' 筆，合計 ' + fmtNt_(sumAmount_(ext))];
    ext.forEach(function (r) {
      lines.push('• ' + slackEscape_(r.payee || r.vendor) + '｜' + slackEscape_(r.purpose) + '｜' + fmtNt_(r.amount) +
        '（提交人 ' + mentionByName_(r.uploader) + '）');
    });
    lines.push(recordsLink);
    postToSlack_(lines.join('\n'));
    posted.push('廠商款已匯出');
  }
  if (batch.type === '20號') {
    postToSlack_(monthlySummary_(paidDate.slice(0, 7)).text);
    posted.push('月付款總結');
  }
  return posted;
}

// 月付款總結：付款日期在這個月的所有單據，依中心統計（每個進行中的中心都列出，沒有款項的顯示 0 筆）
function monthlySummary_(month) {
  const table = readMasterTable_();
  const byCenter = {};
  const order = [];
  activeCenters_().forEach(function (c) { byCenter[c.name] = { count: 0, amount: 0 }; order.push(c.name); });
  let total = 0;
  let totalAmount = 0;
  table.rows.forEach(function (row) {
    const paid = formatDateOnly_(row[MASTER_PAYDATE_COL - 1]);
    if (!paid || paid.slice(0, 7) !== month) return;
    const project = findProject_(row[MASTER_PROJECT_COL - 1]);
    const center = project && project.center ? project.center : '（未指定中心）';
    if (!byCenter[center]) { byCenter[center] = { count: 0, amount: 0 }; order.push(center); }
    const amount = Number(row[MASTER_AMOUNT_COL - 1]) || 0;
    byCenter[center].count++;
    byCenter[center].amount += amount;
    total++;
    totalAmount += amount;
  });
  const lines = ['💰 <!channel> 本月（' + month + '）已完成付款 ' + total + ' 筆，合計 ' + fmtNt_(totalAmount), ''];
  order.forEach(function (name) {
    const c = findCenter_(name);
    let url = '';
    try { url = c && c.reviewSheetId ? SpreadsheetApp.openById(c.reviewSheetId).getUrl() : ''; } catch (e) { url = ''; }
    const label = url ? slackLink_(url, name) : slackEscape_(name);
    lines.push('• ' + label + '：' + byCenter[name].count + ' 筆，' + fmtNt_(byCenter[name].amount));
  });
  lines.push('', '款項已匯出，明細可查看各中心審核表的「付款日期」欄。');
  return { text: lines.join('\n'), total: total, totalAmount: totalAmount };
}

/* ============================================================
   團隊後台：首頁問手冊、認識組織、計畫與預算（2026-10 新增）
   ============================================================ */
// 「知識庫設定」分頁：首頁對話要讀哪些手冊、認識組織要放哪些手冊，由管理員在總表維護（檔案 ID 不寫進程式碼，GitHub 是公開的）
const KNOWLEDGE_SHEET_NAME = '知識庫設定';
const KNOWLEDGE_HEADERS = ['名稱', '檔案連結或ID', '用途（對話／認識組織／兩者）', '說明'];
const KNOWLEDGE_PURPOSE_CHAT = '對話';
const KNOWLEDGE_PURPOSE_ABOUT = '認識組織';
const KNOWLEDGE_PURPOSE_BOTH = '兩者';
const KNOWLEDGE_TEXT_LIMIT = 300000; // 一份手冊最多讀這麼多字，避免太大的檔案拖慢每一次回答
// 「媒體報導」分頁：認識組織頁的「最新消息」（受訪、評論、報導），由管理員在總表維護，最新的排最前面
const NEWS_SHEET_NAME = '媒體報導';
// 只填「連結」就可以：日期、標題、媒體、摘要和預覽圖會從文章網頁自動抓（og: 標籤）；有填的格子優先用你填的
const NEWS_HEADERS = ['連結', '類型（受訪／評論／報導）', '日期（空白自動抓）', '標題（空白自動抓）', '媒體（空白自動抓）', '摘要（空白自動抓）', '預覽圖網址（空白自動抓）'];
const NEWS_MAX_ROWS = 30;                 // 只看分頁最下面 30 列（新的一則加在最下面）
const LINK_PREVIEW_CACHE_SECONDS = 21600; // 抓到的預覽存 6 小時
const LINK_PREVIEW_RETRY_SECONDS = 1800;  // 抓不到的，30 分鐘後再試
const QA_LOG_SHEET_NAME = '小U問答紀錄';
const QA_LOG_HEADERS = ['時間', '問題', '回答依據']; // 手冊／一般知識／答不出來；不記是誰問的

/* ---------- 資料導入連結：團隊後台要讀的檔案，統一記在這份試算表 ----------
   「網站後台_資料導入連結」第一個分頁，一列一個檔案：年度｜網站分頁｜用途｜檔案名稱｜連結｜…
   系統看「用途」找檔案：
   - 有「手冊」→ 小U 和「認識組織」讀的手冊（標題用「用途」那格）
   - 有「最新消息」或「媒體」→ 最新消息：受訪與評論（讀那份試算表的第一個分頁）
   - 有「金流表」→ 計畫與預算（讀它的「網站摘要」分頁）
   同一個用途有好幾年時，用今年那一列；沒有今年就用最新年度（「不分年度」也可以）。
   這份試算表的網址（或檔案 ID）放在指令碼屬性 DATA_REGISTRY_ID，不寫進程式碼（GitHub 是公開的）；
   預覽測試可以填另一份副本。沒設定、或這份表格沒有填某種檔案時，照舊讀總表的「知識庫設定」「媒體報導」分頁、
   用收支總表算計畫與預算。 */
const DATA_REGISTRY_ID_PROP = 'DATA_REGISTRY_ID';
const REGISTRY_CACHE_SECONDS = 300;     // 改了資料導入連結，最晚 5 分鐘生效
const CASHFLOW_SUMMARY_SHEET = '網站摘要';
const CASHFLOW_CENTER_OWN = '中心營運';  // 「網站摘要」專案欄空白＝中心本身的人事費、業務費

let _registryRows = null; // 同一次執行內只讀一次
let _registrySs = null;   // 同一次執行內只開一次資料導入那份試算表（最新消息、團隊個性化也可能放在同一份）

// 打開試算表；資料導入那份在同一次執行裡重複用，不要開好幾次
function openSpreadsheet_(id) {
  if (id && id === dataRegistryId_()) {
    if (!_registrySs || _registrySs.getId() !== id) _registrySs = SpreadsheetApp.openById(id);
    return _registrySs;
  }
  return SpreadsheetApp.openById(id);
}

function dataRegistryId_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty(DATA_REGISTRY_ID_PROP) || '').trim();
  return fileIdFromUrl_(raw) || raw; // 貼整個網址或只貼 ID 都可以
}

// 給選單①的檢查：資料導入連結有沒有設定、打不打得開；金流表的「網站摘要」有沒有找不到的列
function registryWarnings_() {
  const id = dataRegistryId_();
  if (!id) return ['指令碼屬性還沒有 ' + DATA_REGISTRY_ID_PROP + '（填「網站後台_資料導入連結」的網址）：手冊、最新消息、計畫與預算會照舊讀總表的分頁。'];
  try {
    SpreadsheetApp.openById(id);
  } catch (e) {
    return ['打不開「網站後台_資料導入連結」（指令碼屬性 ' + DATA_REGISTRY_ID_PROP + '）：請確認網址正確、已經共用給 service@skillsforu.org。'];
  }
  if (!loadRegistry_().length) {
    return ['「網站後台_資料導入連結」的第一個分頁讀不到任何檔案：標題列要有「用途」「連結」兩欄，下面每一列填用途和連結。'];
  }
  if (!registryFind_(CASHFLOW_PURPOSE_PATTERN).length) return [];
  const cf = cashflowOverview_();
  if (!cf.ok) return ['計畫與預算：' + cf.error];
  return (cf.warnings || []).map(function (w) { return '計畫與預算：' + w; });
}

// 整份表格讀成一列一列（第一列是標題）
function readAllRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 1) return [];
  return sheet.getRange(1, 1, last, sheet.getMaxColumns()).getValues();
}

function loadRegistry_() {
  if (_registryRows) return _registryRows;
  const id = dataRegistryId_();
  if (!id) return (_registryRows = []);
  const cache = CacheService.getScriptCache();
  const key = 'registry_v2_' + id; // v2：多記連結裡的分頁（gid）
  const hit = cache.get(key);
  if (hit) {
    try {
      return (_registryRows = JSON.parse(hit));
    } catch (e) { /* 壞掉的快取就重讀 */ }
  }
  let rows = [];
  try {
    // 資料導入連結的分頁：標題列（前幾列）有「用途」和「連結」的那個分頁，通常是第一個；同一份檔案可以放別的分頁（例如最新消息）
    const trim = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };
    let values = null;
    let hi = -1;
    openSpreadsheet_(id).getSheets().some(function (sheet) {
      const v = readAllRows_(sheet);
      for (let i = 0; i < Math.min(v.length, 10); i++) {
        const cells = v[i].map(trim);
        if (cells.indexOf('用途') >= 0 && cells.indexOf('連結') >= 0) { values = v; hi = i; return true; }
      }
      return false;
    });
    if (hi < 0) throw new Error('找不到有「用途」「連結」欄的分頁');
    const header = values[hi].map(trim);
    const at = function (r, name) { const i = header.indexOf(name); return i < 0 ? '' : trim(r[i]); };
    rows = values.slice(hi + 1).map(function (r) {
      const url = at(r, '連結');
      const gid = (url.match(/[#?&]gid=(\d+)/) || [])[1] || '';
      return { year: at(r, '年度'), page: at(r, '網站分頁'), purpose: at(r, '用途'), name: at(r, '檔案名稱'), url: url, id: fileIdFromUrl_(url), gid: gid };
    }).filter(function (r) { return r.purpose && r.id; });
  } catch (e) {
    console.warn('讀不到資料導入連結（' + id + '，要共用給 service@skillsforu.org）：' + e);
    return (_registryRows = []);
  }
  try {
    cache.put(key, JSON.stringify(rows), REGISTRY_CACHE_SECONDS);
  } catch (e) { /* 存不了就下次再讀 */ }
  return (_registryRows = rows);
}

// 每一種用途只留一列：今年 > 最新年度 > 不分年度
function registryPick_(rows) {
  const thisYear = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy'));
  const score = function (r) {
    const y = Number(String(r.year).replace(/[^\d]/g, ''));
    if (y === thisYear) return 1e6;
    return y > 0 ? y : 0;
  };
  const best = {};
  const order = [];
  (rows || loadRegistry_()).forEach(function (r) {
    const k = r.purpose;
    if (!(k in best)) { best[k] = r; order.push(k); return; }
    if (score(r) > score(best[k])) best[k] = r;
  });
  return order.map(function (k) { return best[k]; });
}

const HANDBOOK_PURPOSE_PATTERN = /手冊/;
const NEWS_PURPOSE_PATTERN = /最新消息|媒體/;
const CASHFLOW_PURPOSE_PATTERN = /金流/;
const PROFILE_PURPOSE_PATTERN = /個性化|同事使用手冊/; // 同事使用手冊（團隊個性化）不算手冊

function registryFind_(pattern) {
  return registryPick_().filter(function (r) { return pattern.test(r.purpose); });
}

// 小U 和「組織文化與工作規範」讀的手冊（用途有「手冊」，但不是同事使用手冊）
function handbookRows_() {
  return registryFind_(HANDBOOK_PURPOSE_PATTERN).filter(function (r) { return !PROFILE_PURPOSE_PATTERN.test(r.purpose); });
}

// 資料導入連結某一列指到的分頁：連結裡有 #gid= 就用那個分頁；沒有就找跟「檔案名稱」同名的分頁；再沒有就用第一個分頁。
// 所以同一份試算表的不同分頁，貼各自分頁的網址就好。
function registrySheet_(row) {
  const ss = openSpreadsheet_(row.id);
  const sheets = ss.getSheets();
  if (row.gid) {
    const byGid = sheets.filter(function (sh) { return String(sh.getSheetId()) === String(row.gid); })[0];
    if (byGid) return byGid;
  }
  return (row.name && ss.getSheetByName(row.name)) || sheets[0];
}

function loadKnowledgeEntries_() {
  const fromRegistry = handbookRows_().map(function (r) {
    return { title: r.purpose, fileId: r.id, purpose: KNOWLEDGE_PURPOSE_BOTH, description: r.name ? '檔案：' + r.name : '' };
  });
  if (fromRegistry.length) return fromRegistry;
  const sheet = getOrCreateSheet_(KNOWLEDGE_SHEET_NAME, KNOWLEDGE_HEADERS, []);
  return readSheetRows_(sheet, KNOWLEDGE_HEADERS.length).map(function (r) {
    const link = String(r[1] || '').trim();
    return {
      title: String(r[0] || '').trim(),
      fileId: fileIdFromUrl_(link) || link,
      purpose: String(r[2] || '').trim() || KNOWLEDGE_PURPOSE_BOTH,
      description: String(r[3] || '').trim(),
    };
  }).filter(function (e) { return e.title && e.fileId; });
}

function canViewBudget_(email) {
  const key = String(email || '').toLowerCase();
  const person = personByEmail_(key);
  if (person && person.financeRoles.length) return true;
  return loadConfig_().centers.some(function (c) {
    return c.approverEmails.some(function (e) { return e.toLowerCase() === key; });
  });
}

// 用登入的服務帳號權限呼叫 Google Drive API（不需要另外開進階服務）
function driveApi_(method, path, payload) {
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (payload) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/' + path, opts);
  return { code: res.getResponseCode(), text: res.getContentText() };
}

// 從 pptx 的投影片 XML 抽出文字，每一頁前面標「（第 N 頁）」，回答時才能附上頁數
function pptxText_(blob) {
  const entries = Utilities.unzip(blob);
  const slides = entries
    .filter(function (b) { return /^ppt\/slides\/slide\d+\.xml$/.test(b.getName()); })
    .sort(function (a, b) {
      return Number(a.getName().match(/(\d+)\.xml$/)[1]) - Number(b.getName().match(/(\d+)\.xml$/)[1]);
    });
  const decode = function (s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  return slides.map(function (b, i) {
    const xml = b.getDataAsString('UTF-8');
    const paragraphs = xml.split('</a:p>').map(function (p) {
      const texts = [];
      p.replace(/<a:t>([^<]*)<\/a:t>/g, function (m, t) { texts.push(decode(t)); return m; });
      return texts.join('').trim();
    }).filter(Boolean);
    return '（第 ' + (i + 1) + ' 頁）\n' + paragraphs.join('\n');
  }).join('\n\n');
}

// 讀一份手冊的文字：Google 文件／簡報直接匯出純文字；pptx 小檔直接拆，大檔（>40MB）先暫時轉成 Google 簡報再匯出
function extractKnowledgeText_(fileId) {
  const file = DriveApp.getFileById(fileId);
  const mime = file.getMimeType();
  if (mime === MimeType.GOOGLE_DOCS || mime === MimeType.GOOGLE_SLIDES) {
    const res = driveApi_('get', 'files/' + fileId + '/export?mimeType=text%2Fplain');
    if (res.code !== 200) throw new Error('匯出文字失敗（HTTP ' + res.code + '）');
    return res.text;
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    if (file.getSize() <= 40 * 1024 * 1024) return pptxText_(file.getBlob());
    const copy = driveApi_('post', 'files/' + fileId + '/copy?supportsAllDrives=true&fields=id', {
      name: '（團隊後台暫存，可刪除）' + file.getName(),
      mimeType: 'application/vnd.google-apps.presentation',
    });
    if (copy.code !== 200) throw new Error('檔案太大（' + Math.round(file.getSize() / 1024 / 1024) + ' MB），轉成 Google 簡報也失敗（HTTP ' + copy.code + '）。請把它另存成 Google 簡報，再把那份的連結填進「網站後台_資料導入連結」。');
    const tempId = JSON.parse(copy.text).id;
    try {
      const res = driveApi_('get', 'files/' + tempId + '/export?mimeType=text%2Fplain');
      if (res.code !== 200) throw new Error('匯出文字失敗（HTTP ' + res.code + '）');
      return res.text;
    } finally {
      driveApi_('delete', 'files/' + tempId + '?supportsAllDrives=true');
    }
  }
  if (mime === MimeType.PLAIN_TEXT) return file.getBlob().getDataAsString('UTF-8');
  throw new Error('不支援這種檔案（' + mime + '），請用 Google 文件、Google 簡報或 pptx。');
}

// 手冊文字快取：同一份檔案沒有改過就不重讀（存在 CacheService，最多 6 小時；中文一個字最多 3 bytes，所以切小塊存）
function cachedKnowledgeText_(entry) {
  const cache = CacheService.getScriptCache();
  const updated = DriveApp.getFileById(entry.fileId).getLastUpdated().getTime();
  const key = 'kb_' + entry.fileId + '_' + updated;
  const head = cache.get(key + '_n');
  if (head) {
    const n = Number(head);
    const parts = cache.getAll(Array.apply(null, Array(n)).map(function (_, i) { return key + '_' + i; }));
    const chunks = [];
    for (let i = 0; i < n; i++) chunks.push(parts[key + '_' + i]);
    if (chunks.every(function (c) { return typeof c === 'string'; })) return chunks.join('');
  }
  const text = String(extractKnowledgeText_(entry.fileId) || '').replace(/\r\n/g, '\n').slice(0, KNOWLEDGE_TEXT_LIMIT);
  const CHUNK = 25000;
  const values = {};
  let count = 0;
  for (let i = 0; i < text.length; i += CHUNK) { values[key + '_' + count] = text.slice(i, i + CHUNK); count++; }
  values[key + '_n'] = String(count);
  try {
    cache.putAll(values, 21600);
  } catch (e) {
    console.warn('手冊文字快取失敗（不影響回答，只是下次會重讀）：' + e);
  }
  return text;
}

function loadKnowledgeTexts_() {
  const docs = [];
  const warnings = [];
  loadKnowledgeEntries_()
    .filter(function (e) { return e.purpose === KNOWLEDGE_PURPOSE_CHAT || e.purpose === KNOWLEDGE_PURPOSE_BOTH; })
    .forEach(function (e) {
      try {
        const text = cachedKnowledgeText_(e);
        if (text.trim()) docs.push({ title: e.title, text: text });
        else warnings.push('「' + e.title + '」讀不到任何文字。');
      } catch (err) {
        warnings.push('「' + e.title + '」讀取失敗：' + ((err && err.message) || err));
      }
    });
  return { docs: docs, warnings: warnings };
}

// 呼叫 Gemini（同 recognizeReceipt_ 的重試規則：只對 500/503 重打）
function callGemini_(payload) {
  const apiKey = geminiApiKey_();
  if (!apiKey) return { ok: false, error: '尚未設定 GEMINI_API_KEY（請到 Apps Script「專案設定 → 指令碼屬性」新增）' };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  const opts = {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  };
  let res = UrlFetchApp.fetch(url, opts);
  let status = res.getResponseCode();
  [1000, 2000].forEach(function (delay) {
    if (status !== 500 && status !== 503) return;
    Utilities.sleep(delay);
    res = UrlFetchApp.fetch(url, opts);
    status = res.getResponseCode();
  });
  if (status !== 200) return { ok: false, error: 'Gemini API 錯誤（狀態碼 ' + status + '）' };
  const data = JSON.parse(res.getContentText());
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  if (!text) return { ok: false, error: 'Gemini 沒有回傳可用內容' };
  return { ok: true, text: text };
}

// 首頁的「小U」：Skills for U 的新手導師，像組織內部的客服，同仁可以問任何事，也可以跟她聊天。
// 組織的事只照手冊、〈團隊後台使用說明〉、〈組織沿革〉、〈團隊與審核〉、〈組織最新消息〉回答（找不到就說沒寫、建議問誰）；
// 一般工作問題可以用一般知識回答，標成 kind: 'general'，網頁上會註明「這只是小U的想法，不是組織規定」；
// 打招呼、道謝、閒聊、問小U自己標成 kind: 'chat'，網頁上不加註記。
const XIAOU_PERSONA = [
  '你是「小U」，Skills for U（社團法人國際技能發展協會）的新手導師，在團隊後台陪同仁解決問題，像組織內部的客服，也像可以隨口聊兩句的同事。',
  '你的形象：技職出身的年輕女生，熱心、關心社會議題、以臺灣為主體思考。口吻親切自然，像可靠的學姊，說話簡潔，不撒嬌、不用表情符號。',
  '你的設定：MBTI 是 ESFJ（執政官型），天秤座。熱心又細心，喜歡把事情安排好，最見不得同事卡關。有人問起你自己，就照這個設定回答。',
  '對話方式：',
  '• 像真人聊天一樣自然回應：打招呼就打招呼回去，道謝就回應，閒聊就陪聊兩句。不清楚對方想做什麼時，反問一句。',
  '• 對話紀錄裡有前文時，接著前文理解（例如上一題問代墊款，接著問「那廠商呢？」就是在問廠商的款項怎麼付）。',
  '• 回答長度跟著問題走：閒聊一兩句就好，問流程再條列步驟。',
  '回答規則：',
  '1. 組織的事（規定、流程、福利、制度、文化、人事、財務、組織資訊）只能根據〈手冊〉、〈團隊後台使用說明〉、〈組織沿革〉、〈團隊與審核〉和〈組織最新消息〉回答，並附上出處。找不到就直接說沒有寫到，建議可以問誰（例如直屬主管、會計，或執行長偉翔），不要自己推測。',
  '2. 問到組織裡的人（例如老闆、同事是怎樣的人）：只說資料裡寫到的事實（職稱、負責什麼、最近的受訪或評論），不評論個性、不八卦、不替別人下定論；可以建議對方直接找本人聊聊。',
  '3. 一般問題（工作技巧、文書處理、溝通、技職教育常識等）可以用一般知識回答，但不能說成是組織規定。',
  '4. 不確定就說不確定；不要編造人名、金額、日期、規定或網址。不要在回答裡寫出任何密碼（例如 Wi-Fi、門禁、帳號密碼），請對方直接問後勤。',
  '5. 用繁體中文（台灣用語）。先講結論，需要步驟時用「• 」開頭條列。不要用 Markdown 標題或表格。',
  '只輸出 JSON：{"answer": "回答內容", "kind": "handbook" 或 "general" 或 "chat" 或 "none", "sources": [{"title": "資料名稱", "location": "第幾頁或哪一段"}]}',
  'kind：根據上面這些資料回答填 "handbook"；用一般知識回答填 "general"（sources 留空）；打招呼、道謝、閒聊、聊你自己填 "chat"（sources 留空）；組織的事但資料裡找不到填 "none"。',
].join('\n');

const XIAOU_KINDS = ['handbook', 'general', 'chat', 'none'];
const XIAOU_HISTORY_MAX = 10;   // 帶最近 10 則對話，讓追問接得上前文

// 「認識組織」最上面的「我們是誰」：組織沿革和旗下品牌，小U 也會讀（〈組織沿革〉）。
// 只寫查得到出處的事。要改字改這裡，改完照第 9 節重新部署。
const ORG_STORY = {
  title: '我們是誰',
  summary: 'Skills for U 從一個人的技職媒體起家：2014 年偉翔創立《技職3.0》報導技職議題，2018 年擴大成社團法人國際技能發展協會。現在協會經營 Skills for U 和 OPEN 技職兩個品牌，每年舉辦臺灣技職教育年會。',
  milestones: [
    { year: '2014', title: '創立《技職3.0》', text: '偉翔創立獨立媒體《技職3.0》，報導技職與職訓議題，也做技職政策的專題報導，曾被立委拿來質詢教育部。' },
    { year: '2018', title: '成立 Skills for U', text: '把一個人經營的《技職3.0》擴大成非營利組織：Skills for U（社團法人國際技能發展協會）。' },
    { year: '2023', title: '臺灣技職教育年會', text: '舉辦臺灣技職教育年會，邀請產官學一起討論技職人才培育。' },
    { year: '2024', title: '技職力100', text: '舉辦「技職力100」全國評選，找出能在校園和企業之間擴散的育才模式，每兩年一屆。' },
    { year: '2026', title: '藍色未來 BlueFuture', text: '帶技職青年進入 AI 供應鏈的職位：2026–2028 年要讓至少 500 位技職青年在 AI 供應鏈就業。' },
  ],
  brands: [
    {
      name: 'Skills for U', formerly: '',
      text: '協會本身的品牌：把企業資源帶進技職學校，規劃成培力方案；現在的主力是藍色未來 BlueFuture。',
      links: [{ platform: 'Facebook', url: 'https://www.facebook.com/skillsforu2018' }],
    },
    {
      name: 'OPEN 技職', formerly: '技職3.0',
      text: '協會旗下的媒體品牌，前身是《技職3.0》。從報導技職議題起家，現在用影音和社群開箱技職教育現場與職場，講技職人的故事，也記錄技能競賽和技職國手。',
      links: [
        { platform: 'Facebook', url: 'https://www.facebook.com/open.skills.to.all' },
        { platform: 'Instagram', url: 'https://www.instagram.com/openskillstoall/' },
        { platform: 'Threads', url: 'https://www.threads.com/@openskillstoall' },
      ],
    },
    {
      name: '臺灣技職教育年會', formerly: '',
      text: '每年舉辦，邀請產官學一起討論技職人才培育。2026 年在 7 月 15 日國際青年技能日舉行，300 多位產官學代表參加。',
      links: [{ platform: 'Facebook', url: 'https://www.facebook.com/profile.php?id=61558222603288' }],
    },
  ],
};

// 給小U的〈組織沿革〉
function storyKnowledgeText_() {
  const lines = [ORG_STORY.summary];
  ORG_STORY.milestones.forEach(function (m) { lines.push('（' + m.year + '）' + m.title + '：' + m.text); });
  ORG_STORY.brands.forEach(function (b) {
    lines.push('（' + b.name + (b.formerly ? '，前身是' + b.formerly : '') + '）' + b.text +
      ' 社群：' + b.links.map(function (l) { return l.platform + ' ' + l.url; }).join('；'));
  });
  return lines.join('\n');
}

// 系統內建的使用說明（跟著程式一起更新，不用放進知識庫設定）。只寫系統真的這樣運作的事。
const SYSTEM_GUIDE_TITLE = '團隊後台使用說明';
const SYSTEM_GUIDE_TEXT = [
  '（團隊後台的分頁）首頁是跟小U對話；認識組織底下有四頁：「認識組織」是組織介紹、我們是誰和最新的受訪、評論，「組織文化與工作規範」是組織手冊和組織文化手冊的重點（也能直接打開手冊），「認識團隊」是組織架構和團隊成員，「同事使用手冊」是同事自己寫的使用說明書；人事中心連到 Swingvy；核銷作業底下有「上傳單據」「上傳紀錄」，會計和放行人另外有「財務作業」；「計畫與預算」只有財務和各中心主管看得到。',
  '（同事使用手冊）到「認識組織 › 同事使用手冊」選一位同事，可以看他自己寫的工作時段、找他最好的方式、喜歡怎麼收到回饋、可以找他幫忙的事，也可以跟他的虛擬分身聊天。虛擬分身只照使用說明書回答，不代表本人；要本人決定的事請直接找本人。想放上自己的使用說明書，請管理員在「團隊個性化」分頁幫你新增一列，「同意放上網站」填「是」。',
  '（上傳單據）到「核銷作業 › 上傳單據」，選中心、專案和單據類型，拍照或選檔案（JPG、PNG、PDF，PDF 最大 5 MB）。選好專案就會自動辨識日期、金額、店家和發票號碼，核對後送出。送出後可以按「上傳下一張，沿用」把專案、預算項目和付款方式帶到下一張。',
  '（這筆錢要怎麼付）五選一：我先墊錢了（代墊款，主管核准後每月 5 號跟薪資一起匯）；請組織直接匯款給廠商或外部個人（要填戶名、7 碼分行代碼、帳號，一般在每月 20 號付；每月固定支出可以選在 5 號付）；繳費單（稅金、健保費等，會計用網銀代繳，要填繳費期限）；已經用組織信用卡或零用金付掉了；需要組織刷卡（線上刷卡連結或紙本刷卡）。',
  '（審核與付款時間）各中心主管每月 10–13 號審核。趕時間的單據可以標「緊急」並填希望付款的日期，送出時會馬上通知主管。送出畫面會顯示預計撥款日，實際以財務作業為準。',
  '（看進度）到「核銷作業 › 上傳紀錄」看每一張單據的審核和付款進度，收款帳號只顯示末 4 碼。被退回會在 Slack 收到通知，照退回原因補好再重新上傳。放行時沒有付款的，會寫出原因並排進下一批。',
  '（紙本單據）紙本正本要交給後勤，會計核對紙本和電子檔相符後，才算單據完備。紙本有問題時，上傳人會在 Slack 收到補件通知。',
  '（找誰）付款進度的問題先看「上傳紀錄」，還有疑問找會計；系統用不順或出現錯誤訊息，截圖給執行長偉翔。',
  '（組織的社群）Facebook：Skills for U https://www.facebook.com/skillsforu2018 ；OPEN 技職 https://www.facebook.com/open.skills.to.all ；臺灣技職教育年會 https://www.facebook.com/profile.php?id=61558222603288 。Instagram：OPEN 技職 https://www.instagram.com/openskillstoall/ 。Threads：OPEN 技職 https://www.threads.com/@openskillstoall 。',
  '（常用工具）團隊後台的「常用工具」分頁會陸續放上同仁常用的小工具，例如名片掃描；還沒上線的會標「即將推出」。',
  '（計畫與預算）數字來自當年度金流表的「網站摘要」分頁，會計每月結算完更新：「全年」是 1–12 月合計（還沒結算的月份是預估），「已結算」是 1 月到結算月的實際支出，「剩餘」是全年減已結算。',
].join('\n');

function askHandbook_(body, auth) {
  const question = String(body.question || '').trim().slice(0, 500);
  if (!question) return { ok: false, error: '請先輸入問題。' };
  const kb = loadKnowledgeTexts_();
  const notConfigured = !kb.docs.length;
  const docs = [{ title: SYSTEM_GUIDE_TITLE, text: SYSTEM_GUIDE_TEXT }].concat(kb.docs);
  let extra = notConfigured
    ? '\n目前還沒有接上任何組織手冊：組織規定的問題，請說你還沒拿到手冊、建議可以問誰；系統操作、閒聊和一般問題照常回答。'
    : '';
  const askerName = String((auth && auth.name) || '').trim();
  if (askerName) extra += '\n現在跟你說話的同仁是「' + askerName + '」，打招呼時可以叫對方的名字。';
  const extraDocs = [];
  try {
    const team = teamKnowledgeText_();
    if (team) extraDocs.push({ title: '團隊與審核', text: team });
  } catch (e) {
    console.warn('小U讀團隊名單失敗：' + e);
  }
  extraDocs.push({ title: '組織沿革', text: storyKnowledgeText_() });
  try {
    const news = newsKnowledgeText_();
    if (news) extraDocs.push({ title: '組織最新消息', text: news });
  } catch (e) {
    console.warn('小U讀媒體報導失敗：' + e);
  }
  const knowledge = docs.map(function (d) { return '〈手冊：' + d.title + '〉\n' + d.text; })
    .concat(extraDocs.map(function (d) { return '〈' + d.title + '〉\n' + d.text; }))
    .join('\n\n');
  const contents = (Array.isArray(body.history) ? body.history : []).slice(-XIAOU_HISTORY_MAX)
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim(); })
    .map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.text).slice(0, 2000) }] };
    });
  contents.push({ role: 'user', parts: [{ text: question }] });
  const result = callGemini_({
    systemInstruction: { parts: [{ text: XIAOU_PERSONA + extra + '\n\n' + knowledge }] },
    contents: contents,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
  });
  if (!result.ok) return { ok: false, error: result.error };
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (e) {
    parsed = { answer: result.text, kind: 'general', sources: [] };
  }
  let kind = String(parsed.kind || '');
  if (XIAOU_KINDS.indexOf(kind) === -1) kind = parsed.found === false ? 'none' : 'handbook';
  const answer = String(parsed.answer || '').trim().slice(0, 4000) || '這題我答不出來，可以問直屬主管，或截圖給執行長偉翔。';
  const sources = kind === 'handbook' ? (Array.isArray(parsed.sources) ? parsed.sources : []).slice(0, 6).map(function (s) {
    return { title: String((s && s.title) || '').slice(0, 60), location: String((s && s.location) || '').slice(0, 60) };
  }).filter(function (s) { return s.title; }) : [];
  const found = kind !== 'none';
  try {
    logQuestion_(question, kind);
  } catch (e) {
    console.warn('小U問答紀錄寫入失敗：' + e);
  }
  const out = { ok: true, answer: answer, kind: kind, found: found, sources: sources, notConfigured: notConfigured };
  if (kb.warnings.length) out.warnings = kb.warnings;
  return out;
}

// 記下大家問了什麼、手冊有沒有答案（不記是誰問的），用來找出手冊還缺哪些內容
function logQuestion_(question, kind) {
  const sheet = getOrCreateSheet_(QA_LOG_SHEET_NAME, QA_LOG_HEADERS, []);
  const label = { handbook: '手冊', general: '一般知識', chat: '閒聊', none: '答不出來' }[kind] || '答不出來';
  sheet.appendRow([nowText_(), question, label]);
}

// 給小U的〈團隊與審核〉：各中心的審核人和專案、誰是會計和放行人（跟「認識組織」頁看得到的一樣，不放 Email）
function teamKnowledgeText_() {
  const cfg = loadConfig_();
  const lines = [];
  activeCenters_().forEach(function (c) {
    const approvers = c.approverEmails.map(approverDisplayName_).filter(function (n) { return n; });
    const projects = activeProjects_().filter(function (p) { return p.center === c.name; }).map(function (p) { return p.name; });
    lines.push('（' + c.name + '）單據審核人：' + (approvers.length ? approvers.join('、') : '還沒設定') +
      (projects.length ? '；專案：' + projects.join('、') : ''));
  });
  const withRole = function (role) {
    return cfg.people.filter(function (p) { return p.financeRoles.indexOf(role) !== -1; }).map(function (p) { return p.name; });
  };
  const accountants = withRole(FINANCE_ROLE_ACCOUNTANT);
  const releasers = withRole(FINANCE_ROLE_RELEASER);
  if (accountants.length) lines.push('會計：' + accountants.join('、') + '（付款批次、付款進度的問題可以找會計）');
  if (releasers.length) lines.push('放行人：' + releasers.join('、') + '（在銀行端放行付款）');
  const names = cfg.people.map(function (p) { return p.name; });
  if (names.length) lines.push('團隊成員：' + names.join('、'));
  return lines.join('\n');
}

// 給小U的〈組織最新消息〉：「媒體報導」分頁最新 10 則（受訪、評論、報導）
function newsKnowledgeText_() {
  return loadNews_().slice(0, 10).map(function (n) {
    return [n.date, n.type, n.title, n.outlet, n.summary, n.url].filter(function (v) { return v; }).join('｜');
  }).join('\n');
}

/* ---------- 同事使用手冊：資料導入那份試算表的「團隊個性化」分頁 ----------
   一人一列，本人自己填；「同意放上網站」填「是」才會出現在團隊後台。欄位看標題裡的字，順序可以換。
   資料導入連結裡有「團隊個性化」那一列就讀它指的分頁；沒有的話，讀資料導入那份檔案裡叫「團隊個性化」的分頁。 */
const PROFILE_SHEET_NAME = '團隊個性化';
const PROFILE_TEXT_LIMIT = 300;
const PROFILE_ABOUT_LIMIT = 1000;
// 依序比對（例如「可以找我幫忙的事」要先算「幫忙」，不能被「找我」搶走）
const PROFILE_FIELDS = [
  { key: 'email', match: /email|信箱/i },
  { key: 'consent', match: /同意|公開/ },
  { key: 'name', match: /姓名|名字/ },
  { key: 'mbti', match: /mbti/i },
  { key: 'blood', match: /血型/ },
  { key: 'zodiac', match: /星座/ },
  { key: 'help', match: /幫忙|擅長/ },
  { key: 'feedback', match: /回饋/ },
  { key: 'contact', match: /找我|聯絡/ },
  { key: 'hours', match: /時段|習慣/ },
  { key: 'life', match: /興趣|生活/ },
  { key: 'voice', match: /說話|語氣|口頭禪/ },
  { key: 'about', match: /自我描述|自我介紹|關於我/ },
  { key: 'title', match: /職稱|負責/ },
];
const PROFILE_LABELS = {
  title: '職稱與負責的事', mbti: 'MBTI', blood: '血型', zodiac: '星座', hours: '工作時段與習慣', contact: '找我最好的方式',
  feedback: '我喜歡怎麼收到回饋', help: '可以找我幫忙的事', life: '興趣與生活', voice: '說話風格', about: '自我描述',
};

function profilesSheet_() {
  const row = registryFind_(PROFILE_PURPOSE_PATTERN)[0];
  try {
    if (row) return registrySheet_(row);
    const id = dataRegistryId_();
    return id ? openSpreadsheet_(id).getSheetByName(PROFILE_SHEET_NAME) : null;
  } catch (e) {
    console.warn('讀不到團隊個性化分頁：' + e);
    return null;
  }
}

function isYes_(v) {
  if (v === true) return true;
  return /^(是|y|yes|true|v|✓|✔|ok|同意|可以)$/i.test(String(v === undefined || v === null ? '' : v).trim());
}

// 同意放上網站的同事（id 用 Email 小寫；沒填 Email 就用姓名）
function loadProfiles_() {
  const sheet = profilesSheet_();
  if (!sheet) return [];
  const values = readAllRows_(sheet);
  const trim = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };
  let hi = -1;
  for (let i = 0; i < Math.min(values.length, 5) && hi < 0; i++) {
    if (values[i].map(trim).some(function (h) { return /姓名|名字/.test(h); })) hi = i;
  }
  if (hi < 0) return [];
  const col = {};
  values[hi].map(trim).forEach(function (h, i) {
    if (!h) return;
    for (let f = 0; f < PROFILE_FIELDS.length; f++) {
      const field = PROFILE_FIELDS[f];
      if (!(field.key in col) && field.match.test(h)) { col[field.key] = i; break; }
    }
  });
  if (!('name' in col)) return [];
  const seen = {};
  return values.slice(hi + 1).map(function (r) {
    const at = function (k, n) { return k in col ? trim(r[col[k]]).slice(0, n || PROFILE_TEXT_LIMIT) : ''; };
    const name = at('name', 40);
    const email = at('email', 120).toLowerCase();
    const p = { id: email || name, name: name, email: email };
    Object.keys(PROFILE_LABELS).forEach(function (k) { p[k] = at(k, k === 'about' ? PROFILE_ABOUT_LIMIT : PROFILE_TEXT_LIMIT); });
    p.consent = 'consent' in col ? isYes_(r[col.consent]) : false;
    return p;
  }).filter(function (p) {
    if (!p.name || !p.consent || seen[p.id]) return false;
    seen[p.id] = true;
    return true;
  }).map(function (p) { delete p.consent; return p; });
}

// 給虛擬分身的說明書（照本人填的欄位，空白的不放）
function profileManualText_(p) {
  return ['title', 'mbti', 'blood', 'zodiac', 'hours', 'contact', 'feedback', 'help', 'life', 'voice', 'about']
    .filter(function (k) { return p[k]; })
    .map(function (k) { return '（' + PROFILE_LABELS[k] + '）' + p[k]; })
    .join('\n');
}

// 這位同事在團隊後台的角色（哪個中心的主管、財務角色），從人員設定和中心設定來
function profileRolesText_(p) {
  try {
    const cfg = loadConfig_();
    const person = cfg.people.filter(function (x) {
      return (p.email && String(x.email || '').toLowerCase() === p.email) || x.name === p.name;
    })[0];
    const lines = [];
    activeCenters_().forEach(function (c) {
      if (person && c.approverEmails.some(function (e) { return e.toLowerCase() === String(person.email || '').toLowerCase(); })) {
        lines.push('「' + c.name + '」的主管，負責審核這個中心的單據');
      }
    });
    if (person && person.financeRoles.length) lines.push('財務角色：' + person.financeRoles.join('、'));
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

const COLLEAGUE_PERSONA = [
  '你是 Skills for U 同事「{name}」的虛擬分身，在團隊後台的「同事使用手冊」陪同仁聊天，讓大家更認識{name}、知道怎麼跟{name}合作。',
  '規則：',
  '1. 只能根據下面〈{name} 的使用說明書〉和〈在團隊後台的角色〉回答，這些是本人自己寫的。說明書沒寫到的事不要猜、不要編，直接說說明書沒寫、建議直接問本人，並說用什麼方式找本人比較好。',
  '2. 用第一人稱，像{name}本人在 Slack 回同事；語氣照〈說話風格〉和〈自我描述〉，簡短自然，可以打招呼、閒聊兩句。',
  '3. 不能替本人答應任何事（例如幫忙、時間、金額、核准、請假），也不能替本人做決定；遇到這類事，請對方直接找本人。',
  '4. 不評論其他同事、不八卦，不透露說明書以外的個人資訊；不寫任何密碼。',
  '5. 有人問你是不是本人，要誠實說你是照本人填的使用說明書回答的虛擬分身。',
  '6. 用繁體中文（台灣用語），不要用 Markdown 標題或表格。',
  '只輸出 JSON：{"answer": "回答內容"}',
].join('\n');

// 跟同事的虛擬分身聊天（不記錄對話內容）
function askColleague_(body, auth) {
  const question = String(body.question || '').trim().slice(0, 500);
  if (!question) return { ok: false, error: '請先輸入問題。' };
  const id = String(body.colleague || '').trim().toLowerCase();
  const p = loadProfiles_().filter(function (x) { return x.id.toLowerCase() === id; })[0];
  if (!p) return { ok: false, error: '找不到這位同事的使用說明書（可能還沒填，或還沒同意放上網站）。' };
  const roles = profileRolesText_(p);
  const askerName = String((auth && auth.name) || '').trim();
  let system = COLLEAGUE_PERSONA.replace(/\{name\}/g, p.name);
  if (askerName) {
    system += '\n現在跟你說話的同仁是「' + askerName + '」' + (askerName === p.name ? '，就是本人在試用自己的虛擬分身' : '') + '。';
  }
  system += '\n\n〈' + p.name + ' 的使用說明書〉\n' + (profileManualText_(p) || '（還沒寫內容）');
  if (roles) system += '\n\n〈在團隊後台的角色〉\n' + roles;
  const contents = (Array.isArray(body.history) ? body.history : []).slice(-XIAOU_HISTORY_MAX)
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim(); })
    .map(function (m) { return { role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.text).slice(0, 2000) }] }; });
  contents.push({ role: 'user', parts: [{ text: question }] });
  const result = callGemini_({
    systemInstruction: { parts: [{ text: system }] },
    contents: contents,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.5 },
  });
  if (!result.ok) return { ok: false, error: result.error };
  let answer = '';
  try {
    const parsed = JSON.parse(result.text);
    answer = typeof parsed === 'string' ? parsed : String((parsed || {}).answer || '');
  } catch (e) {
    answer = String(result.text || '');
  }
  answer = answer.trim().slice(0, 2000) || '這題我答不出來，直接問我本人比較準。';
  return { ok: true, answer: answer };
}

function getAbout_() {
  const cfg = loadConfig_();
  const handbooks = loadKnowledgeEntries_()
    .filter(function (e) { return e.purpose === KNOWLEDGE_PURPOSE_ABOUT || e.purpose === KNOWLEDGE_PURPOSE_BOTH; })
    .map(function (e) {
      return {
        title: e.title, description: e.description,
        openUrl: 'https://drive.google.com/file/d/' + e.fileId + '/view',
        previewUrl: 'https://drive.google.com/file/d/' + e.fileId + '/preview',
      };
    });
  const centers = activeCenters_().map(function (c) {
    return {
      name: c.name,
      approvers: c.approverEmails.map(approverDisplayName_),
      projects: activeProjects_().filter(function (p) { return p.center === c.name; }).map(function (p) { return p.name; }),
    };
  });
  const people = cfg.people.map(function (p) {
    const email = String(p.email || '').toLowerCase();
    return {
      name: p.name, email: p.email, financeRoles: p.financeRoles,
      approverOf: email ? activeCenters_().filter(function (c) {
        return c.approverEmails.some(function (e) { return e.toLowerCase() === email; });
      }).map(function (c) { return c.name; }) : [],
    };
  });
  let profiles = [];
  try {
    profiles = loadProfiles_();
  } catch (e) {
    console.warn('讀同事使用手冊失敗：' + e);
  }
  return { ok: true, story: ORG_STORY, handbooks: handbooks, centers: centers, people: people, news: loadNews_(), profiles: profiles };
}

// 最新消息的來源：資料導入連結裡「最新消息／媒體」那份試算表的第一個分頁；沒填就用總表的「媒體報導」分頁
function newsSheet_() {
  const row = registryFind_(NEWS_PURPOSE_PATTERN)[0];
  if (row) {
    try {
      return registrySheet_(row);
    } catch (e) {
      console.warn('打不開最新消息的試算表「' + (row.name || row.id) + '」（要共用給 service@skillsforu.org）：' + e);
      return null;
    }
  }
  return getOrCreateSheet_(NEWS_SHEET_NAME, NEWS_HEADERS, []);
}

function loadNews_() {
  const sheet = newsSheet_();
  if (!sheet) return [];
  const types = ['受訪', '評論', '報導'];
  const rows = readSheetRows_(sheet, NEWS_HEADERS.length).map(function (r) {
    return {
      url: String(r[0] || '').trim(),
      type: String(r[1] || '').trim(),
      date: formatDateOnly_(r[2]),
      title: String(r[3] || '').trim(),
      outlet: String(r[4] || '').trim(),
      summary: String(r[5] || '').trim(),
      image: String(r[6] || '').trim(),
    };
  }).filter(function (r) { return /^https?:\/\/[^\s]+$/.test(r.url); }).slice(-NEWS_MAX_ROWS);
  let previews = {};
  try {
    previews = linkPreviews_(rows.map(function (r) { return r.url; }));
  } catch (e) {
    console.warn('抓文章預覽失敗：' + e);
  }
  return rows.map(function (r, i) {
    const p = previews[r.url] || {};
    return {
      date: r.date || p.date || '',
      type: types.indexOf(r.type) !== -1 ? r.type : '報導',
      title: (r.title || p.title || r.url).slice(0, 120),
      outlet: (r.outlet || p.outlet || hostOf_(r.url)).slice(0, 40),
      url: r.url,
      summary: (r.summary || p.summary || '').slice(0, 160),
      image: (/^https:\/\/[^\s"'<>]+$/.test(r.image) ? r.image : p.image || '').slice(0, 600),
      order: i,
    };
  }).sort(function (a, b) {
    return String(b.date).localeCompare(String(a.date)) || a.order - b.order;
  }).slice(0, 20).map(function (n) {
    delete n.order;
    return n;
  });
}

// 文章連結的預覽（像社群貼連結那樣）：一次平行抓所有網址，讀 og:title、og:image、og:description、og:site_name、
// article:published_time。抓到的存快取 6 小時，抓不到的 30 分鐘後再試。
function linkPreviews_(urls) {
  const out = {};
  if (!urls.length) return out;
  const cache = CacheService.getScriptCache();
  const keyOf = function (u) {
    return 'og_v1_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, u));
  };
  let cached = {};
  try {
    cached = cache.getAll(urls.map(keyOf)) || {};
  } catch (e) {
    cached = {};
  }
  const missing = [];
  urls.forEach(function (u) {
    const hit = cached[keyOf(u)];
    if (hit) {
      try {
        out[u] = JSON.parse(hit);
        return;
      } catch (e) { /* 壞掉的快取就重抓 */ }
    }
    if (missing.indexOf(u) === -1) missing.push(u);
  });
  if (!missing.length) return out;
  let responses = [];
  try {
    responses = UrlFetchApp.fetchAll(missing.map(function (u) {
      return { url: u, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SkillsForU-TeamPortal/1.0)' } };
    }));
  } catch (e) {
    console.warn('抓文章預覽失敗：' + e);
  }
  const good = {};
  const bad = {};
  missing.forEach(function (u, i) {
    const res = responses[i];
    let meta = null;
    try {
      if (res && res.getResponseCode() === 200) meta = parseLinkPreview_(String(res.getContentText()).slice(0, 400000), u);
    } catch (e) {
      meta = null;
    }
    out[u] = meta || {};
    if (meta && (meta.title || meta.image)) good[keyOf(u)] = JSON.stringify(meta);
    else bad[keyOf(u)] = JSON.stringify(out[u]);
  });
  try {
    if (Object.keys(good).length) cache.putAll(good, LINK_PREVIEW_CACHE_SECONDS);
    if (Object.keys(bad).length) cache.putAll(bad, LINK_PREVIEW_RETRY_SECONDS);
  } catch (e) { /* 快取存不了就下次再抓 */ }
  return out;
}

function parseLinkPreview_(html, pageUrl) {
  const head = String(html).split(/<\/head>/i)[0];
  const metas = {};
  const tags = head.match(/<meta\b[^>]*>/gi) || [];
  tags.forEach(function (tag) {
    const key = (htmlAttr_(tag, 'property') || htmlAttr_(tag, 'name') || htmlAttr_(tag, 'itemprop')).toLowerCase();
    const content = htmlAttr_(tag, 'content');
    if (key && content && !(key in metas)) metas[key] = decodeHtml_(content).replace(/\s+/g, ' ').trim();
  });
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  let image = metas['og:image:secure_url'] || metas['og:image'] || metas['og:image:url'] || metas['twitter:image'] || metas['twitter:image:src'] || '';
  image = absoluteUrl_(image, pageUrl).replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\/[^\s"'<>]+$/.test(image)) image = '';
  const published = metas['article:published_time'] || metas['og:article:published_time'] || metas['date'] || metas['pubdate'] || '';
  return {
    title: cleanTitle_(metas['og:title'] || metas['twitter:title'] || decodeHtml_(titleTag).replace(/\s+/g, ' ').trim()).slice(0, 120),
    image: image.slice(0, 600),
    summary: (metas['og:description'] || metas['description'] || metas['twitter:description'] || '').slice(0, 160),
    outlet: (metas['og:site_name'] || '').slice(0, 40),
    date: /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : '',
  };
}

// 網頁標題常帶網站名稱（「標題 - 想想論壇」「標題｜作者｜獨立評論」），去掉後面那段；前段太短就不動
function cleanTitle_(t) {
  const full = String(t || '').trim();
  const first = full.split(/\s+[-–—|]\s+|｜/)[0].trim();
  return first !== full && first.length >= 8 ? first : full;
}

function htmlAttr_(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

function decodeHtml_(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function absoluteUrl_(u, base) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ''; // javascript:、data: 之類的不要
  const origin = (String(base).match(/^(https?:\/\/[^/?#]+)/i) || [])[1] || '';
  if (!origin) return '';
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return origin + u;
  return String(base).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/') + u;
}

function hostOf_(url) {
  return (String(url).match(/^https?:\/\/([^/?#:]+)/i) || [])[1] || '';
}

// 認識組織的內容：小U 從「知識庫設定」用途是「認識組織／兩者」的手冊整理出重點（Gemini），
// 手冊沒改就用快取（6 小時）；手冊一改，檔案的修改時間變了，下次就會重新整理。
// 組織名稱的寫法（認識組織最上面的大標題固定用這個，不讓 AI 自己寫）
const ORG_DISPLAY_NAME = 'Skills for U（社團法人國際技能發展協會）';

const ABOUT_OVERVIEW_PROMPT = [
  '你是「小U」，Skills for U 的新手導師，要幫新同仁做「認識組織」頁面。根據下面的手冊，整理出這個頁面的內容。',
  '規則：只能用手冊裡寫的內容，不要補充、不要推測；手冊沒寫的就不要放。不要放任何密碼、門禁或帳號資訊。用繁體中文（台灣用語），句子短、好讀。',
  'intro：name 一律寫「' + ORG_DISPLAY_NAME + '」、tagline（一句話說明組織在做什麼，30 字內）、summary（2～3 句介紹，120 字內；提到組織名稱時寫 Skills for U）。',
  'sections：4～7 個段落，依手冊實際內容決定，例如：我們是誰、使命與願景、核心價值、我們怎麼做事、組織架構與分工、工作須知、福利與制度。每個段落 2～6 個重點。',
  '每個重點：title（14 字內）、text（90 字內）、location（出處：第幾頁或哪一段）。每個段落的 handbook 填這段主要出自哪一本手冊（照〈手冊：…〉的名稱）。',
  '只輸出 JSON：{"intro": {"name": "", "tagline": "", "summary": ""}, "sections": [{"title": "", "handbook": "", "points": [{"title": "", "text": "", "location": ""}]}]}',
].join('\n');

function getAboutOverview_() {
  const entries = loadKnowledgeEntries_().filter(function (e) {
    return e.purpose === KNOWLEDGE_PURPOSE_ABOUT || e.purpose === KNOWLEDGE_PURPOSE_BOTH;
  });
  if (!entries.length) {
    return { ok: true, overview: { status: 'notConfigured', sections: [], intro: null, updatedAt: '',
      message: '還沒有設定手冊。請管理員在「網站後台_資料導入連結」填入組織手冊、組織文化手冊的連結（用途要有「手冊」兩個字）。' } };
  }
  let fingerprint;
  try {
    fingerprint = entries.map(function (e) { return e.fileId + ':' + DriveApp.getFileById(e.fileId).getLastUpdated().getTime(); }).join('|');
  } catch (err) {
    return { ok: true, overview: { status: 'unavailable', sections: [], intro: null, updatedAt: '', message: '讀不到手冊檔案：' + ((err && err.message) || err) } };
  }
  const cache = CacheService.getScriptCache();
  const key = ('about_v2_' + fingerprint).slice(0, 240); // v2：大標題固定用 ORG_DISPLAY_NAME
  const hit = cache.get(key);
  if (hit) {
    try { return { ok: true, overview: JSON.parse(hit) }; } catch (e) { /* 快取壞了就重做 */ }
  }
  const docs = [];
  const problems = [];
  entries.forEach(function (e) {
    try {
      const text = cachedKnowledgeText_(e);
      if (text.trim()) docs.push('〈手冊：' + e.title + '〉\n' + text);
      else problems.push('「' + e.title + '」讀不到任何文字');
    } catch (err) {
      problems.push('「' + e.title + '」讀取失敗：' + ((err && err.message) || err));
    }
  });
  if (!docs.length) {
    return { ok: true, overview: { status: 'unavailable', sections: [], intro: null, updatedAt: '', message: problems.join('；') || '讀不到手冊內容。' } };
  }
  const result = callGemini_({
    systemInstruction: { parts: [{ text: ABOUT_OVERVIEW_PROMPT + '\n\n' + docs.join('\n\n') }] },
    contents: [{ role: 'user', parts: [{ text: '請整理「認識組織」頁面的內容。' }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  if (!result.ok) return { ok: true, overview: { status: 'unavailable', sections: [], intro: null, updatedAt: '', message: '整理手冊內容失敗：' + result.error } };
  let parsed;
  try { parsed = JSON.parse(result.text); } catch (e) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.sections)) {
    return { ok: true, overview: { status: 'unavailable', sections: [], intro: null, updatedAt: '', message: '整理出來的內容格式不對，請稍後再試一次。' } };
  }
  const str = function (v, n) { return String(v || '').trim().slice(0, n); };
  const intro = parsed.intro || {};
  const overview = {
    status: 'ready',
    message: problems.length ? problems.join('；') : '',
    updatedAt: nowText_(),
    intro: { name: ORG_DISPLAY_NAME, tagline: str(intro.tagline, 60), summary: str(intro.summary, 240) },
    sections: parsed.sections.slice(0, 8).map(function (sec) {
      return {
        title: str(sec && sec.title, 30),
        handbook: str(sec && sec.handbook, 60),
        points: (Array.isArray(sec && sec.points) ? sec.points : []).slice(0, 8).map(function (pt) {
          return { title: str(pt && pt.title, 30), text: str(pt && pt.text, 200), location: str(pt && pt.location, 40) };
        }).filter(function (pt) { return pt.title || pt.text; }),
      };
    }).filter(function (sec) { return sec.title && sec.points.length; }),
  };
  try {
    cache.put(key, JSON.stringify(overview), 21600);
  } catch (e) {
    console.warn('認識組織內容快取失敗（不影響顯示，只是下次會重新整理）：' + e);
  }
  return { ok: true, overview: overview };
}

// 試算表的數字格：公式算出來的是數字；手打的「1,234」也認得；空白、「找不到」等文字回傳 NaN
function sheetNumber_(v) {
  if (typeof v === 'number') return v;
  const t = String(v === undefined || v === null ? '' : v).replace(/[,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

// 計畫與預算讀金流表的「網站摘要」分頁（資料導入連結裡「金流表」那一列）。網站只顯示這一頁的總結。
// 「網站摘要」的格式：A2 年度、B3 結算到幾月；A 欄寫「中心」的那一列是標題，下面一列一筆：
//   中心｜專案（空白＝中心本身）｜類別｜全年｜已結算｜剩餘｜執行率｜來源分頁｜來源列｜…，遇到「合計」就停。
// 回傳的形狀跟原本的計畫與預算一樣（中心 → 專案 → 項目），多 source: 'cashflow'：
//   預算＝全年（含還沒結算月份的預估）、已付款＝已結算，前端改用「全年／已結算／剩餘」的字。
// 資料導入連結沒有金流表就回傳 null（改用收支總表算）。
function cashflowOverview_() {
  const row = registryFind_(CASHFLOW_PURPOSE_PATTERN)[0];
  if (!row) return null;
  let ss;
  try {
    ss = SpreadsheetApp.openById(row.id);
  } catch (e) {
    return { ok: false, error: '打不開金流表「' + (row.name || row.id) + '」：請確認已經共用給 service@skillsforu.org。' };
  }
  const sheet = ss.getSheetByName(CASHFLOW_SUMMARY_SHEET);
  if (!sheet) return { ok: false, error: '金流表「' + ss.getName() + '」裡沒有「' + CASHFLOW_SUMMARY_SHEET + '」分頁。' };
  const values = readAllRows_(sheet);
  let year = '';
  let month = 0;
  let headerRow = -1;
  values.forEach(function (r, i) {
    const a = String(r[0] || '').trim();
    if (headerRow >= 0) return;
    if (a === '年度') year = String(r[1] || '').trim();
    else if (a === '結算到幾月') month = Math.max(0, Math.min(12, Math.floor(Number(r[1]) || 0)));
    else if (a === '中心') headerRow = i;
  });
  if (headerRow < 0) return { ok: false, error: '「' + CASHFLOW_SUMMARY_SHEET + '」找不到標題列（A 欄寫「中心」的那一列）。' };
  const zero = function () { return { approved: 0, paid: 0, pending: 0, count: 0 }; };
  const centers = [];
  const warnings = [];
  for (let i = headerRow + 1; i < values.length; i++) {
    const r = values[i];
    const center = String(r[0] || '').trim();
    if (center === '合計') break;
    if (!center) continue;
    const project = String(r[1] || '').trim();
    const category = String(r[2] || '').trim() || '支出';
    const full = sheetNumber_(r[3]);
    const settled = sheetNumber_(r[4]);
    const ok = isFinite(full) && isFinite(settled);
    if (!ok) warnings.push('「' + center + (project ? '／' + project : '') + '／' + category + '」在金流表找不到數字：請檢查「' + CASHFLOW_SUMMARY_SHEET + '」第 ' + (i + 1) + ' 列的來源分頁和來源列。');
    let c = centers.filter(function (x) { return x.name === center; })[0];
    if (!c) { c = { name: center, projects: [] }; centers.push(c); }
    const pname = project || CASHFLOW_CENTER_OWN;
    let p = c.projects.filter(function (x) { return x.name === pname; })[0];
    if (!p) {
      p = { name: pname, own: !project, status: '', budget: 0, approved: 0, paid: 0, pending: 0, items: [], unassigned: zero() };
      c.projects.push(p);
    }
    const budget = ok ? full : 0;
    const paid = ok ? settled : 0;
    p.items.push({ category: category, item: '', budget: budget, approved: paid, paid: paid, pending: 0, count: 0, missing: !ok });
    p.budget += budget;
    p.approved += paid;
    p.paid += paid;
  }
  centers.forEach(function (c) {
    c.projects.sort(function (a, b) { return (a.own ? 0 : 1) - (b.own ? 0 : 1); }); // 中心營運排第一個，其他照網站摘要的順序
  });
  const totals = { budget: 0, approved: 0, paid: 0, pending: 0 };
  centers.forEach(function (c) {
    c.projects.forEach(function (p) {
      totals.budget += p.budget;
      totals.approved += p.approved;
      totals.paid += p.paid;
    });
  });
  const out = {
    ok: true, source: 'cashflow', year: year, settledMonth: month, sourceName: ss.getName(),
    generatedAt: nowText_(), totals: totals, centers: centers,
  };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// 計畫與預算：有金流表就讀「網站摘要」（上面 cashflowOverview_）；沒有的話，用預算（預算項目設定「預算金額」欄）
// 對照收支總表的實際金額：已核准（含已付款）＝已用；待審核＝審核中；被退回的不算。只開放給中心審核人和有財務角色的人。
function getBudgetOverview_(auth) {
  if (!canViewBudget_(auth.email)) return { ok: false, error: '這一頁只開放給主管和財務。' };
  const cashflow = cashflowOverview_();
  if (cashflow) return cashflow;
  const cfg = loadConfig_();
  const table = readMasterTable_();
  const blank = function () { return { approved: 0, paid: 0, pending: 0, count: 0 }; };
  const projectStats = {};
  const ensureProject = function (name) {
    if (!projectStats[name]) projectStats[name] = { items: {}, unassigned: blank() };
    return projectStats[name];
  };
  table.rows.forEach(function (row) {
    const status = String(row[MASTER_STATUS_COL - 1] || '');
    if (status !== STATUS_OPTIONS[0] && status !== STATUS_OPTIONS[1]) return; // 被退回的不算
    const name = String(row[MASTER_PROJECT_COL - 1] || '').trim();
    if (!name) return;
    const st = ensureProject(name);
    const item = String(row[MASTER_BUDGET_ITEM_COL - 1] || '').trim();
    const known = (cfg.budgetItemsByProject[name] || []).some(function (b) { return b.item === item; });
    const bucket = known ? (st.items[item] = st.items[item] || blank()) : st.unassigned;
    const amount = Number(row[MASTER_AMOUNT_COL - 1]) || 0;
    bucket.count++;
    if (status === STATUS_OPTIONS[1]) {
      bucket.approved += amount;
      if (formatDateOnly_(row[MASTER_PAYDATE_COL - 1])) bucket.paid += amount;
    } else {
      bucket.pending += amount;
    }
  });
  const totals = { budget: 0, approved: 0, paid: 0, pending: 0 };
  const buildProject = function (p) {
    const st = ensureProject(p.name);
    const items = (cfg.budgetItemsByProject[p.name] || []).map(function (b) {
      const s = st.items[b.item] || blank();
      return { category: b.category, item: b.item, budget: b.budget, approved: s.approved, paid: s.paid, pending: s.pending, count: s.count };
    });
    const out = {
      name: p.name, status: p.status,
      budget: items.reduce(function (t, i) { return t + i.budget; }, 0),
      approved: items.reduce(function (t, i) { return t + i.approved; }, 0) + st.unassigned.approved,
      paid: items.reduce(function (t, i) { return t + i.paid; }, 0) + st.unassigned.paid,
      pending: items.reduce(function (t, i) { return t + i.pending; }, 0) + st.unassigned.pending,
      items: items, unassigned: st.unassigned,
    };
    totals.budget += out.budget;
    totals.approved += out.approved;
    totals.paid += out.paid;
    totals.pending += out.pending;
    return out;
  };
  const centers = cfg.centers.map(function (c) {
    return { name: c.name, ended: c.status === PROJECT_STATUS_ENDED, projects: cfg.projects.filter(function (p) { return p.center === c.name; }).map(buildProject) };
  }).filter(function (c) { return !c.ended || c.projects.some(function (p) { return p.approved || p.pending; }); });
  // 總表裡有資料、但專案設定找不到（或所屬中心對不上）的專案，集中放在「其他」，金額才不會憑空消失
  const placed = {};
  centers.forEach(function (c) { c.projects.forEach(function (p) { placed[p.name] = true; }); });
  const orphans = Object.keys(projectStats).filter(function (name) { return !placed[name]; }).map(function (name) {
    return buildProject({ name: name, status: '（專案設定找不到）' });
  });
  if (orphans.length) centers.push({ name: '其他（專案設定對不上的）', ended: false, projects: orphans });
  return { ok: true, generatedAt: nowText_(), totals: totals, centers: centers };
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
    '• 每月 ' + DIGEST_DAY_OF_MONTH + ' 號上午 10 點發送審核提醒到 Slack（tag 各中心審核人；遇週末自動順延到下一個週一）\n\n' +
    '付款通知不用排程：會計在團隊後台「財務作業」按「確認已付款」時會自動發（20 號那批另外發月付款總結）。'
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
  const preview = isPreviewMode_();
  // 「設成預覽測試用副本」只在副本（名稱有「預覽」或「測試」）才出現，正式總表的選單看不到
  let showPreviewItem = preview;
  try { showPreviewItem = preview || /預覽|測試/.test(SpreadsheetApp.getActiveSpreadsheet().getName()); } catch (e) { /* 讀不到名稱就不顯示 */ }
  const menu = SpreadsheetApp.getUi()
    .createMenu(preview ? '核銷小幫手（預覽測試）' : '核銷小幫手')
    .addItem('① 建立/更新設定與審核表', 'setupProjectReviewSheets')
    .addItem('② 設定自動排程', 'setupTriggers')
    .addSeparator()
    .addItem('立即同步審核結果 / 付款日期', 'syncApprovalsNow')
    .addItem('立即發送待審提醒到 Slack', 'sendPendingDigestToSlack')
    .addItem('💰 立即發送付款通知到 Slack', 'sendPaymentDigestToSlack');
  if (showPreviewItem) {
    menu.addSeparator()
      .addItem(preview ? '🧪 預覽測試模式：已開啟（再執行一次會重新檢查）' : '🧪 設成預覽測試用副本', 'setupPreviewCopy');
  }
  menu.addToUi();
}

/**
 * 把「總表的副本」設成預覽測試用（說明見最上面「預覽測試模式」）。只能從選單執行。
 * 防呆：試算表名稱一定要有「預覽」或「測試」，而且會先跳確認，避免在正式總表上誤按。
 */
function setupPreviewCopy() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = ss.getName();
  if (ss.getId() === PRODUCTION_MASTER_SPREADSHEET_ID) {
    ui.alert('這份是正式總表，不能設成預覽測試用。請先「檔案 → 建立副本」，在副本上執行。');
    return;
  }
  if (!/預覽|測試/.test(name)) {
    ui.alert('為了避免在正式總表上執行，這個選單只能在名稱有「預覽」或「測試」的試算表上執行。\n\n' +
      '請確認這份是副本，把名稱改成例如「核銷小幫手總表（預覽測試）」後再執行一次。\n\n目前名稱：' + name);
    return;
  }
  const answer = ui.alert('設成預覽測試用副本',
    '這會把「' + name + '」設成預覽測試用：\n\n' +
    '• Slack 不會真的發，改寫進「' + SLACK_PREVIEW_SHEET_NAME + '」分頁\n' +
    '• 上傳的檔案、各中心審核表改放在新的「核銷小幫手（預覽測試）」資料夾\n' +
    '• 新建的審核表不會自動分享給審核人\n' +
    '• 這份副本「' + CENTERS_SHEET_NAME + '」「' + PROJECTS_SHEET_NAME + '」裡的資料夾 ID、審核表 ID 會清空，改用新的（正式總表不受影響）\n\n' +
    '確定這份是副本、不是正式總表嗎？', ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;

  const props = PropertiesService.getScriptProperties();
  props.setProperty(MASTER_SPREADSHEET_ID_PROP_, ss.getId());
  props.setProperty(PREVIEW_MODE_PROP_, 'on');
  // 複製試算表時指令碼屬性可能一起被複製過來：副本一律不留 Slack 網址，雙重保險（不影響正式總表的設定）
  props.deleteProperty('SLACK_WEBHOOK_URL');
  props.deleteProperty('SLACK_WEBHOOK_URL_ORGDEV');
  let folderId = getSecret_(PREVIEW_ROOT_FOLDER_PROP_, '');
  if (folderId) {
    try { DriveApp.getFolderById(folderId).getName(); } catch (e) { folderId = ''; }
  }
  if (!folderId) props.setProperty(PREVIEW_ROOT_FOLDER_PROP_, DriveApp.createFolder('核銷小幫手（預覽測試）').getId());

  // 副本裡的資料夾 ID、審核表 ID 還指著正式的檔案：清空，讓選單①在預覽資料夾建新的
  const centersSheet = ss.getSheetByName(CENTERS_SHEET_NAME);
  if (centersSheet && centersSheet.getLastRow() >= 2) {
    const n = centersSheet.getLastRow() - 1;
    const range = centersSheet.getRange(2, 4, n, 3); // 主資料夾ID、審核表ID、審核表連結
    const values = range.getValues();
    const keep = values.map(function (row, i) {
      // 已經是預覽資料夾裡建的審核表（重跑這個選單時）就保留，不要重建一份
      const id = String(row[1] || '').trim();
      if (id) {
        try {
          const file = DriveApp.getFileById(id);
          const parents = file.getParents();
          while (parents.hasNext()) {
            const parent = parents.next();
            const grand = parent.getParents();
            if (grand.hasNext() && grand.next().getId() === getSecret_(PREVIEW_ROOT_FOLDER_PROP_, '')) return ['', row[1], row[2]];
          }
        } catch (e) { /* 打不開就當成要重建 */ }
      }
      return ['', '', ''];
    });
    range.setValues(keep);
  }
  const projectsSheet = ss.getSheetByName(PROJECTS_SHEET_NAME);
  if (projectsSheet && projectsSheet.getLastRow() >= 2) {
    projectsSheet.getRange(2, 4, projectsSheet.getLastRow() - 1, 1).clearContent(); // 憑證資料夾ID
  }
  _configCache = null;
  getOrCreateSheet_(SLACK_PREVIEW_SHEET_NAME, ['時間', '會發到哪個頻道', '訊息內容（預覽測試模式，不會真的發到 Slack）'], []);
  setupProjectReviewSheets();
}

/**
 * 授權用測試函式。在「指令碼屬性」設定好 GEMINI_API_KEY 後，在編輯器上方的函式下拉選單選「testGeminiAuth」
 * 並按「執行」，Google 會跳出授權畫面（要允許「連線至外部服務」這項權限）。
 *
 * 注意：函式名稱結尾「不能」有底線，否則 Apps Script 會視為私有函式而不顯示在下拉選單中。
 */
function testGeminiAuth() {
  var tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  Logger.log('GEMINI_API_KEY 來源：' + secretSource_('GEMINI_API_KEY', GEMINI_API_KEY));
  Logger.log(JSON.stringify(recognizeReceipt_(tinyImage)));
}

/**
 * Slack 測試函式（同上，函式名稱結尾不能有底線）。在「指令碼屬性」設定好 SLACK_WEBHOOK_URL 後，
 * 在函式下拉選單選「testSlackWebhook」→ 執行：會往通知頻道發一則測試訊息，並在記錄印出結果。
 * 換 webhook 或換頻道之後，用這個確認新網址可用（HTTP 200 = 成功）。
 */
function testSlackWebhook() {
  var source = secretSource_('SLACK_WEBHOOK_URL', SLACK_WEBHOOK_URL);
  if (source === 'none') {
    Logger.log('尚未設定 SLACK_WEBHOOK_URL，請到「專案設定 → 指令碼屬性」新增。');
    return;
  }
  var code = postToSlack_('✅ 核銷小幫手：Slack 通知設定測試（可忽略這則訊息）');
  Logger.log('Slack 測試結果：HTTP ' + code + '（來源：' + source + '）' +
    (code === 200 ? ' ✅ 成功' : ' ❌ 失敗：請確認 webhook 網址正確、沒有被撤銷'));
}

/**
 * 財務頻道 Slack 測試（同上）。在「指令碼屬性」設定好 SLACK_WEBHOOK_URL_ORGDEV 後執行，
 * 會往 #team-組織發展中心 發一則測試訊息。
 */
function testSlackFinanceWebhook() {
  var source = secretSource_('SLACK_WEBHOOK_URL_ORGDEV', '');
  if (source === 'none') {
    Logger.log('尚未設定 SLACK_WEBHOOK_URL_ORGDEV，請到「專案設定 → 指令碼屬性」新增。');
    return;
  }
  var code = postToSlack_('✅ 團隊後台：財務頻道 Slack 通知測試（可忽略這則訊息）', 'finance');
  Logger.log('財務頻道 Slack 測試結果：HTTP ' + code + (code === 200 ? ' ✅ 成功' : ' ❌ 失敗：請確認 webhook 網址正確、沒有被撤銷'));
}

/**
 * 知識庫測試（同上）。填好「網站後台_資料導入連結」（或總表「知識庫設定」）後執行：逐份讀取手冊，在記錄印出每一份讀到幾個字、有沒有錯誤。
 * 第一次執行時 Google 可能會要求授權（讀取雲端硬碟檔案），按允許即可。
 */
function testKnowledgeBase() {
  var entries = loadKnowledgeEntries_();
  if (!entries.length) {
    Logger.log('「網站後台_資料導入連結」和「' + KNOWLEDGE_SHEET_NAME + '」都還沒有填任何手冊。');
    return;
  }
  entries.forEach(function (e) {
    try {
      var text = cachedKnowledgeText_(e);
      Logger.log('✅ ' + e.title + '（用途：' + e.purpose + '）：讀到 ' + text.length + ' 個字。開頭：' + text.slice(0, 80).replace(/\n/g, ' '));
    } catch (err) {
      Logger.log('❌ ' + e.title + '：' + ((err && err.message) || err));
    }
  });
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
