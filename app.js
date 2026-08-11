/* ============================================================
   Skills for U｜單據小幫手
   純瀏覽器端單據上傳、OCR 辨識（Tesseract.js）與審核小工具。
   資料儲存在 localStorage，沒有後端伺服器；OCR 完全離線執行。
   ============================================================ */

const STORAGE_KEY = "skillsForU_receipts_v1";
const CONFIDENCE_THRESHOLD = 80; // 低於此門檻於畫面上醒目標示，需人工複核（規格書第5節）

const UPLOADERS_KEY = "skillsForU_uploaders_v1";
const PROJECTS_KEY = "skillsForU_projects_v1";
const DEFAULT_UPLOADERS = ["黃偉翔", "胡琬茜", "鐘梓豪", "林新樺", "張晏瑄", "王嘉麗", "羅禎瑩", "李唐", "郭采媛"];
const DEFAULT_PROJECTS = ["組織發展中心", "高雄技職年會", "臺灣技職教育年會", "組織行銷中心", "人才培育中心"];

/* ---------------- 資料存取 ---------------- */
function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("讀取本機紀錄失敗", e);
    return [];
  }
}
function saveRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}
function upsertRecord(record) {
  const records = loadRecords();
  const idx = records.findIndex(r => r.id === record.id);
  if (idx >= 0) records[idx] = record; else records.unshift(record);
  saveRecords(records);
}

/* ---------------- 上傳人 / 專案名單 ----------------
   啟用雲端同步後，名單以 Google 試算表的「人員設定」「專案設定」分頁為單一真相來源，
   這裡的 localStorage 只是最近一次抓下來的快取，離線或連線失敗時仍能照常上傳。
   沒啟用雲端同步時，才會退回成純本機、可在「名單設定」頁自行編輯的模式。 */
function loadUploaders() {
  try {
    const raw = localStorage.getItem(UPLOADERS_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_UPLOADERS.slice();
  } catch (e) {
    return DEFAULT_UPLOADERS.slice();
  }
}
function saveUploaders(list) {
  localStorage.setItem(UPLOADERS_KEY, JSON.stringify(list));
}
function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_PROJECTS.slice();
  } catch (e) {
    return DEFAULT_PROJECTS.slice();
  }
}
function saveProjects(list) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
}

// 名單是否由試算表管理（啟用雲端同步就是）
function listsManagedByCloud() {
  const c = loadSyncConfig();
  return !!(c.enabled && c.url);
}

// 從 Apps Script 抓最新名單覆蓋本機快取。回傳是否成功。
async function fetchListsFromCloud() {
  const config = loadSyncConfig();
  if (!config.enabled || !config.url) return { ok: false, error: "尚未啟用雲端同步" };
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: config.token, action: "getConfig" }),
    });
    const data = await res.json();
    if (!data || !data.ok) return { ok: false, error: (data && data.error) || "未知錯誤" };
    if (Array.isArray(data.uploaders)) saveUploaders(data.uploaders);
    if (Array.isArray(data.projects)) saveProjects(data.projects);
    populateUploaderAndProjectSelects();
    return { ok: true, uploaders: data.uploaders, projects: data.projects };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function populateUploaderAndProjectSelects() {
  const currentUploader = uploaderSelect.value;
  const currentProject = projectSelect.value;
  uploaderSelect.innerHTML = '<option value="">請選擇上傳人</option>' +
    loadUploaders().map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  projectSelect.innerHTML = '<option value="">請選擇專案</option>' +
    loadProjects().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  if (loadUploaders().includes(currentUploader)) uploaderSelect.value = currentUploader;
  if (loadProjects().includes(currentProject)) projectSelect.value = currentProject;
}

/* ---------------- 小工具 ---------------- */
function uid() {
  return "R" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function showToast(msg, ms = 2600) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, ms);
}
function fmtMoney(n) {
  if (n === null || n === undefined || n === "") return "—";
  return "NT$ " + Number(n).toLocaleString("zh-TW");
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  // 從雲端「重新整理狀態」抓回來的審核時間，已經是 Code.gs 那邊格式化好的
  // "YYYY-MM-DD HH:mm" 人類可讀字串，直接顯示即可，不用再當 ISO 解析一次（避免各瀏覽器解析行為不一致）
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  return d.toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
/* 對齊 google-sync/Code.gs 的 formatDateTime_：GMT+8、精確到分鐘、"yyyy-MM-dd HH:mm" */
function fmtDateTimeForSheet(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================================================
   分頁切換
   ============================================================ */
const views = {
  upload: document.getElementById("view-upload"),
  mine: document.getElementById("view-mine"),
  lists: document.getElementById("view-lists"),
  sync: document.getElementById("view-sync"),
};
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  switchView(btn.dataset.view);
});
function switchView(name) {
  Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "mine") renderMineView();
  if (name === "lists") renderListsView();
  if (name === "sync") renderSyncView();
}

/* ============================================================
   上傳單據 — 檔案選取 / 拍照
   ============================================================ */
const dropzone = document.getElementById("dropzone");
const dropzoneInner = document.getElementById("dropzoneInner");
const fileInput = document.getElementById("fileInput");
const dzPreview = document.getElementById("dzPreview");
const dzPreviewImg = document.getElementById("dzPreviewImg");
const dzFilename = document.getElementById("dzFilename");
const dzRemoveBtn = document.getElementById("dzRemoveBtn");
const startOcrBtn = document.getElementById("startOcrBtn");
const uploaderSelect = document.getElementById("uploaderSelect");
const projectSelect = document.getElementById("projectSelect");

let selectedFile = null;      // 原始 File
let selectedImageDataUrl = null; // 壓縮後 dataURL（供預覽 / 離線與雲端 OCR / 儲存）
let selectedPdfDataUrl = null;   // PDF 原始 dataURL（離線 OCR 無法處理，僅雲端 OCR／儲存用；保留原始檔存進 Drive）
let selectedPdfPreviewImages = null; // PDF 轉成的壓縮圖片（最多前 3 頁），雲端 OCR 改傳這個而不是整份 PDF，速度快很多

// pdf.js 的頁面渲染依賴 requestAnimationFrame，分頁背景分頁/最小化時瀏覽器會節流甚至完全不觸發，
// 導致 render() 永遠不resolve。幫每一頁的渲染加個安全逾時，超過就放棄轉檔、整份改送原始 PDF，
// 不要讓「開始辨識」卡住等一個永遠不會完成的 Promise。
const PDF_PAGE_RENDER_TIMEOUT_MS = 10000;
function withTimeout_(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " 逾時")), ms)),
  ]);
}

// PDF 直接整份送給 Gemini 常常偏大、拖慢辨識速度，改成在瀏覽器裡先轉成最多 3 頁的壓縮圖片再送出，
// 存進 Drive 的仍是原始 PDF，不受影響。任何一步失敗（含逾時）就回傳空陣列，呼叫端會自動退回用原始 PDF。
async function renderPdfToCompressedImages(pdfDataUrl, maxPages = 3) {
  try {
    if (typeof pdfjsLib === "undefined") return [];
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    const base64 = pdfDataUrl.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pdf = await withTimeout_(pdfjsLib.getDocument({ data: bytes }).promise, PDF_PAGE_RENDER_TIMEOUT_MS, "PDF 解析");
    const pageCount = Math.min(pdf.numPages, maxPages);
    const images = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
      await withTimeout_(renderTask.promise, PDF_PAGE_RENDER_TIMEOUT_MS, "PDF 第 " + i + " 頁渲染").catch((err) => {
        renderTask.cancel();
        throw err;
      });
      images.push(await downscaleImage(canvas.toDataURL("image/jpeg", 0.85), 1400));
    }
    return images;
  } catch (err) {
    console.error("PDF 轉圖片失敗，辨識時將改用原始 PDF：", err);
    return [];
  }
}

dropzone.addEventListener("click", () => { if (!selectedFile) fileInput.click(); });
["dragenter", "dragover"].forEach(evt => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); dropzone.classList.add("dragover");
}));
["dragleave", "drop"].forEach(evt => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); dropzone.classList.remove("dragover");
}));
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFileSelected(f);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
});
dzRemoveBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  resetFileSelection();
});

function resetFileSelection() {
  selectedFile = null;
  selectedImageDataUrl = null;
  selectedPdfDataUrl = null;
  selectedPdfPreviewImages = null;
  fileInput.value = "";
  dzPreview.hidden = true;
  dropzoneInner.hidden = false;
  updateStartButtonState();
}

function handleFileSelected(file) {
  selectedFile = file;
  const isPdf = file.type === "application/pdf";
  if (isPdf) {
    selectedImageDataUrl = null;
    selectedPdfDataUrl = null;
    selectedPdfPreviewImages = null;
    dzPreviewImg.hidden = true;
    const cloudOcrReady = loadSyncConfig().cloudOcrEnabled;
    dzFilename.textContent = "📄 " + file.name + (cloudOcrReady
      ? "（PDF 檔，將使用雲端 OCR 辨識）"
      : "（PDF 檔，離線辨識不支援 PDF，請於下一步手動輸入欄位，或到「雲端同步設定」開啟雲端 OCR）");
    dropzoneInner.hidden = true;
    dzPreview.hidden = false;
    const reader = new FileReader();
    reader.onload = () => {
      selectedPdfDataUrl = reader.result;
      // 先在背景把 PDF 轉成壓縮圖片備用，開始辨識時如果轉檔還沒完成，就直接送原始 PDF，不會卡住等待
      if (cloudOcrReady) {
        renderPdfToCompressedImages(selectedPdfDataUrl).then(images => {
          selectedPdfPreviewImages = images.length ? images : null;
        });
      }
    };
    reader.readAsDataURL(file);
    updateStartButtonState();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    downscaleImage(reader.result, 1400).then(dataUrl => {
      selectedImageDataUrl = dataUrl;
      dzPreviewImg.hidden = false;
      dzPreviewImg.src = dataUrl;
      dzFilename.textContent = file.name;
      dropzoneInner.hidden = true;
      dzPreview.hidden = false;
      updateStartButtonState();
    });
  };
  reader.readAsDataURL(file);
}

function downscaleImage(dataUrl, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

uploaderSelect.addEventListener("change", updateStartButtonState);
projectSelect.addEventListener("change", updateStartButtonState);
function updateStartButtonState() {
  startOcrBtn.disabled = !(selectedFile && uploaderSelect.value && projectSelect.value);
}

/* ============================================================
   OCR 辨識（Tesseract.js，繁體中文 + 英文）
   ============================================================ */
const ocrProgress = document.getElementById("ocrProgress");
const ocrProgressFill = document.getElementById("ocrProgressFill");
const ocrProgressLabel = document.getElementById("ocrProgressLabel");

startOcrBtn.addEventListener("click", runOcr);

function cloudFieldsToConfirmForm(fields) {
  const f = fields || {};
  const guesses = {
    date: f.invoiceDate || null,
    amount: f.amount ? Number(f.amount) : null,
    vendor: f.vendor || null,
  };
  const rawText = f.items ? `（雲端 OCR 品項摘要）${f.items}` : "（雲端 OCR，未提供原始文字）";
  openConfirmForm({ rawText, confidenceMean: Number(f.confidence) || 0, guesses });
}

async function runOcr() {
  const isPdf = selectedFile && selectedFile.type === "application/pdf";
  const syncConfig = loadSyncConfig();
  const cloudOcrReady = syncConfig.enabled && syncConfig.url && syncConfig.cloudOcrEnabled;

  if (isPdf) {
    // 離線辨識（Tesseract）不支援 PDF，只有雲端 OCR（Gemini）能處理
    if (!cloudOcrReady || !selectedPdfDataUrl) {
      showToast(cloudOcrReady ? "PDF 檔案讀取中，請稍後再試一次" : "PDF 檔案僅支援雲端 OCR，請於「雲端同步設定」開啟後再試，或直接手動輸入欄位");
      openConfirmForm({ rawText: "", confidenceMean: 0, guesses: {} });
      return;
    }
    startOcrBtn.disabled = true;
    ocrProgress.hidden = false;
    ocrProgressFill.style.width = "50%";
    ocrProgressLabel.textContent = "雲端辨識中（Gemini，PDF）…";
    // 有轉檔好的壓縮圖片就用它（快很多），沒有（例如轉檔還沒完成或失敗）就退回送整份原始 PDF
    const cloud = await cloudOcrRecognize(selectedPdfPreviewImages || selectedPdfDataUrl);
    ocrProgress.hidden = true;
    startOcrBtn.disabled = false;
    if (cloud.ok) {
      cloudFieldsToConfirmForm(cloud.fields);
    } else {
      showToast("雲端辨識失敗，PDF 無法離線辨識，請手動輸入欄位：" + (cloud.error || "未知錯誤"));
      openConfirmForm({ rawText: "", confidenceMean: 0, guesses: {} });
    }
    return;
  }

  if (!selectedImageDataUrl) {
    openConfirmForm({ rawText: "", confidenceMean: 0, guesses: {} });
    return;
  }
  startOcrBtn.disabled = true;
  ocrProgress.hidden = false;
  ocrProgressFill.style.width = "0%";
  ocrProgressLabel.textContent = "辨識引擎準備中…";

  if (cloudOcrReady) {
    ocrProgressFill.style.width = "50%";
    ocrProgressLabel.textContent = "雲端辨識中（Gemini）…";
    const cloud = await cloudOcrRecognize(selectedImageDataUrl);
    if (cloud.ok) {
      ocrProgressFill.style.width = "100%";
      cloudFieldsToConfirmForm(cloud.fields);
      ocrProgress.hidden = true;
      startOcrBtn.disabled = false;
      return;
    }
    showToast("雲端辨識失敗，改用本機離線辨識：" + (cloud.error || "未知錯誤"));
    ocrProgressFill.style.width = "0%";
    ocrProgressLabel.textContent = "改用本機離線辨識…";
  }

  try {
    const result = await Tesseract.recognize(selectedImageDataUrl, "chi_tra+eng", {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          const pct = Math.round(m.progress * 100);
          ocrProgressFill.style.width = pct + "%";
          const labelMap = {
            "loading tesseract core": "載入辨識引擎…",
            "initializing tesseract": "初始化中…",
            "loading language traineddata": "載入中文語言模型…",
            "initializing api": "準備中…",
            "recognizing text": "辨識文字中…",
          };
          ocrProgressLabel.textContent = (labelMap[m.status] || m.status) + `（${pct}%）`;
        }
      },
    });

    const rawText = normalizeCjkSpacing(result.data.text || "");
    const confidenceMean = Math.round(result.data.confidence || 0);
    const guesses = extractFieldsFromText(rawText);
    openConfirmForm({ rawText, confidenceMean, guesses });
  } catch (err) {
    console.error(err);
    showToast("辨識發生錯誤，請手動輸入欄位");
    openConfirmForm({ rawText: "", confidenceMean: 0, guesses: {} });
  } finally {
    ocrProgress.hidden = true;
    startOcrBtn.disabled = false;
  }
}

/* Tesseract 對中文逐字辨識時常在字元間插入空白，導致關鍵字比對失敗，先收斂掉 */
function normalizeCjkSpacing(text) {
  return text.replace(/([一-鿿])[ \t]+(?=[一-鿿])/g, "$1");
}

/* ---------------- OCR 文字 → 欄位判讀（規則式，供人工確認用） ---------------- */
function extractFieldsFromText(text) {
  const guesses = { date: null, amount: null, vendor: null };

  // 日期：民國年（3碼，加1911換算西元）或西元年
  const dateRe = /(\d{2,4})[年./-](\d{1,2})[月./-](\d{1,2})日?/g;
  let m, bestDate = null;
  while ((m = dateRe.exec(text)) !== null) {
    let [, y, mo, d] = m;
    y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (y < 200) y += 1911; // 民國年換算
    if (y < 2015 || y > 2100) continue;
    bestDate = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  guesses.date = bestDate;

  // 金額：優先找「合計/總計/應付/應收/金額」附近的數字，否則取文字中最大的貨幣數字
  const amountKeywordRe = /(合計|總計|應付金額|應收金額|總金額|金額|small\s*total|total)\D{0,6}?(\d[\d,]*)/gi;
  let amounts = [];
  while ((m = amountKeywordRe.exec(text)) !== null) {
    const v = parseInt(m[2].replace(/,/g, ""), 10);
    if (!isNaN(v) && v > 0) amounts.push(v);
  }
  if (amounts.length === 0) {
    const genericAmountRe = /[$＄]\s?(\d[\d,]{1,8})/g;
    while ((m = genericAmountRe.exec(text)) !== null) {
      const v = parseInt(m[1].replace(/,/g, ""), 10);
      if (!isNaN(v) && v > 0) amounts.push(v);
    }
  }
  guesses.amount = amounts.length ? Math.max(...amounts) : null;

  // 店家：取第一行非空白、非純數字/符號的文字
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  guesses.vendor = lines.find(l => l.replace(/[\d\s\-./:*]/g, "").length >= 2) || null;

  return guesses;
}

/* ============================================================
   確認表單
   ============================================================ */
const confirmCard = document.getElementById("confirmCard");
const confidenceBanner = document.getElementById("confidenceBanner");
const rawOcrText = document.getElementById("rawOcrText");
let currentOcrRawText = "";

const f_date = document.getElementById("f_date");
const f_period = document.getElementById("f_period");
const f_amount = document.getElementById("f_amount");
const f_vendor = document.getElementById("f_vendor");
const f_items = document.getElementById("f_items");
const f_purpose = document.getElementById("f_purpose");
const f_payMethod = document.getElementById("f_payMethod");
const f_payeePerson = document.getElementById("f_payeePerson");
const f_payeeVendor = document.getElementById("f_payeeVendor");
const f_paymentDetail = document.getElementById("f_paymentDetail");
const f_cardConfirm1 = document.getElementById("f_cardConfirm1");
const f_cardConfirm2 = document.getElementById("f_cardConfirm2");
const f_urgentDate = document.getElementById("f_urgentDate");

const PAY_METHOD_MEMBER = "組織匯款（組織人員）";
const PAY_METHOD_VENDOR = "組織匯款（非組織人員）";
const PAY_METHOD_PETTY_CASH = "組織零用金";
const PAY_METHOD_CARD_LINK = "組織信用卡（連結）";
const PAY_METHOD_CARD_PAPER = "組織信用卡（紙本）";

/* 付款方式決定要填哪些收款資訊：
   - 組織匯款（組織人員）：要指定還款對象（預設帶上傳人，但可改，因為常有幫同事代送單據的情況）
   - 組織匯款（非組織人員）：要填收款單位與匯款帳戶
   - 組織零用金：款項已由組織當場支付，不需要收款資訊
   - 組織信用卡（連結）：填線上刷卡連結
   - 組織信用卡（紙本）：填卡號，且要勾選兩項確認才能送出
   「付款資訊」欄位在匯款/連結/卡號三種情境下共用同一個輸入框，只是標籤跟提示文字不同 */
f_payMethod.addEventListener("change", () => { updatePayeeFields(); updatePayoutEstimate(); });
function updatePayeeFields() {
  const method = f_payMethod.value;
  document.getElementById("payeePersonField").hidden = method !== PAY_METHOD_MEMBER;
  document.getElementById("payeeVendorField").hidden = method !== PAY_METHOD_VENDOR;
  document.getElementById("cardConfirmField").hidden = method !== PAY_METHOD_CARD_PAPER;
  if (method === PAY_METHOD_MEMBER) populatePayeePersonOptions();

  const detailField = document.getElementById("paymentDetailField");
  const label = document.getElementById("paymentDetailLabel");
  const hint = document.getElementById("paymentDetailHint");
  if (method === PAY_METHOD_VENDOR) {
    detailField.hidden = false;
    label.innerHTML = '帳號資訊 <span class="req">*</span>';
    f_paymentDetail.placeholder = "銀行／分行、帳號";
    hint.className = "field-hint-example";
    hint.innerHTML = "<strong>範例：</strong>\n華南銀行 城東分行　008_1083\n帳號：94480081415416";
  } else if (method === PAY_METHOD_CARD_LINK) {
    detailField.hidden = false;
    label.innerHTML = '刷卡連結 <span class="req">*</span>';
    f_paymentDetail.placeholder = "貼上對方提供的線上刷卡網址";
    hint.className = "field-hint";
    hint.textContent = "範例：https://payment.example.com/pay/abc123";
  } else {
    // 信用卡（紙本）不用在這裡填卡號——卡號由偉翔另外提供，這裡只留兩項確認勾選
    detailField.hidden = true;
  }
}

function populatePayeePersonOptions() {
  const current = f_payeePerson.value;
  const people = loadUploaders();
  f_payeePerson.innerHTML = '<option value="">請選擇還款對象</option>' +
    people.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  // 預設帶入上傳人，但使用者可以改成別人
  const preferred = people.includes(current) ? current : uploaderSelect.value;
  if (people.includes(preferred)) f_payeePerson.value = preferred;
}

f_date.addEventListener("change", updatePeriodField);
function updatePeriodField() {
  f_period.value = f_date.value ? f_date.value.slice(0, 7) : "";
}

/* ---------------- 預計撥款日期 ----------------
   組織 5 號／20 號固定發款。以「送出審核當下」而不是發票日期為準：
   - 組織匯款（非組織人員／廠商）：9 號前送出 → 當月 20 號；9 號（含）後 → 次月 20 號
   - 組織匯款（組織人員／同仁代墊）：9 號前送出 → 次月 5 號；9 號（含）後 → 次次月 5 號
   其他付款方式（零用金／信用卡）沒有固定發款週期規則，不自動推算。
   標記緊急時，改用上傳人自己選的「希望撥款日期」，不套用這個公式。 */
function computeExpectedPayoutDate(payMethod, submitDate) {
  const day = submitDate.getDate();
  const y = submitDate.getFullYear();
  const m = submitDate.getMonth();
  if (payMethod === PAY_METHOD_VENDOR) {
    return new Date(y, day <= 9 ? m : m + 1, 20);
  }
  if (payMethod === PAY_METHOD_MEMBER) {
    return new Date(y, day <= 9 ? m + 1 : m + 2, 5);
  }
  return null;
}
function fmtDateYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function updatePayoutEstimate() {
  const banner = document.getElementById("payoutEstimateBanner");
  if (currentUrgent) {
    banner.hidden = true; // 緊急件的日期由「希望撥款日期」欄位處理，不重複顯示這個提示
    return;
  }
  const estimated = computeExpectedPayoutDate(f_payMethod.value, new Date());
  if (!estimated) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent = `💰 依目前送出時間推算，預計撥款日期為 ${fmtDateYMD(estimated)}（實際仍以財務作業為準）`;
}

/* 緊急／一般切換：緊急件會在送出當下立刻發 Slack 通知主管，一般件只進定期彙總提醒 */
const urgencyToggle = document.getElementById("urgencyToggle");
let currentUrgent = false;
urgencyToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  currentUrgent = btn.dataset.urgent === "1";
  urgencyToggle.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b === btn));
  document.getElementById("urgentDateField").hidden = !currentUrgent;
  updatePayoutEstimate();
});
function resetUrgency() {
  currentUrgent = false;
  urgencyToggle.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.urgent === "0"));
  document.getElementById("urgentDateField").hidden = true;
  f_urgentDate.value = "";
}

function openConfirmForm({ rawText, confidenceMean, guesses }) {
  currentOcrRawText = rawText;
  rawOcrText.textContent = rawText || "（此檔案未執行文字辨識，請手動輸入欄位）";

  f_date.value = guesses.date || "";
  updatePeriodField();
  f_amount.value = guesses.amount || "";
  f_vendor.value = guesses.vendor || "";
  f_items.value = "";
  f_purpose.value = "";
  f_payMethod.value = "";
  f_payeeVendor.value = "";
  f_paymentDetail.value = "";
  f_cardConfirm1.checked = false;
  f_cardConfirm2.checked = false;
  updatePayeeFields();
  resetUrgency();
  updatePayoutEstimate();

  setFlag("flag-date", !!guesses.date);
  setFlag("flag-amount", !!guesses.amount);

  if (!rawText) {
    confidenceBanner.className = "confidence-banner mid";
    confidenceBanner.textContent = "此檔案未執行自動辨識，請手動填寫以下欄位";
  } else if (confidenceMean >= CONFIDENCE_THRESHOLD) {
    confidenceBanner.className = "confidence-banner high";
    confidenceBanner.textContent = `辨識信心分數 ${confidenceMean}%，看起來不錯，請再核對一次金額與日期`;
  } else if (confidenceMean >= 50) {
    confidenceBanner.className = "confidence-banner mid";
    confidenceBanner.textContent = `辨識信心分數 ${confidenceMean}%，部分欄位可能不準確，請仔細核對`;
  } else {
    confidenceBanner.className = "confidence-banner low";
    confidenceBanner.textContent = `辨識信心分數 ${confidenceMean}%，偏低，建議重新拍攝或手動輸入`;
  }
  confirmCard.dataset.confidence = confidenceMean;

  confirmCard.hidden = false;
  confirmCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setFlag(id, ok) {
  const el = document.getElementById(id);
  el.className = "field-flag " + (ok ? "ok" : "low");
  el.textContent = "";
}

document.getElementById("cancelConfirmBtn").addEventListener("click", () => {
  confirmCard.hidden = true;
  resetFileSelection();
});

document.getElementById("submitRecordBtn").addEventListener("click", submitRecord);

// 檔名規則：{日期}_{金額}元，例如「15_64元」。專案名稱與年月都不放進檔名，
// 因為 Google Drive 那邊會先依專案分資料夾、資料夾裡再依年月分子資料夾
//（見 google-sync/Code.gs 的 getProjectFolder_ / getMonthFolder_），檔名裡重複標沒意義。
function suggestFileName(record, originalName) {
  const ext = (originalName.match(/\.[a-zA-Z0-9]+$/) || [".jpg"])[0];
  const day = record.invoiceDate ? record.invoiceDate.slice(-2) : "未知日";
  return `${day}_${record.amount || 0}元${ext}`;
}

function submitRecord() {
  if (!f_date.value) { showToast("請填寫發票 / 收據日期"); f_date.focus(); return; }
  if (!f_amount.value || Number(f_amount.value) <= 0) { showToast("請填寫金額"); f_amount.focus(); return; }
  if (!f_payMethod.value) { showToast("請選擇付款方式"); f_payMethod.focus(); return; }
  const payMethod = f_payMethod.value;
  if (payMethod === PAY_METHOD_MEMBER && !f_payeePerson.value) {
    showToast("請選擇還款對象"); f_payeePerson.focus(); return;
  }
  if (payMethod === PAY_METHOD_VENDOR) {
    if (!f_payeeVendor.value.trim()) { showToast("請填寫收款單位"); f_payeeVendor.focus(); return; }
    if (!f_paymentDetail.value.trim()) { showToast("請填寫匯款帳戶資訊"); f_paymentDetail.focus(); return; }
  }
  if (payMethod === PAY_METHOD_CARD_LINK && !f_paymentDetail.value.trim()) {
    showToast("請填寫刷卡連結"); f_paymentDetail.focus(); return;
  }
  if (payMethod === PAY_METHOD_CARD_PAPER) {
    // 卡號不在這裡填，由偉翔另外提供；上傳人只需要確認過這兩項才能送出
    if (!f_cardConfirm1.checked || !f_cardConfirm2.checked) {
      showToast("請勾選兩項確認後才能送出（信用卡紙本付款須先確認無法匯款、無法線上刷卡）");
      return;
    }
  }
  if (currentUrgent && !f_urgentDate.value) {
    showToast("標記緊急時，請選擇希望撥款日期"); f_urgentDate.focus(); return;
  }

  // 收款對象：組織匯款（組織人員）記人名、組織匯款（非組織人員）記單位名，其他方式則無（款項已由組織支付）
  const payee = payMethod === PAY_METHOD_MEMBER ? f_payeePerson.value
    : payMethod === PAY_METHOD_VENDOR ? f_payeeVendor.value.trim() : "";
  const paymentDetail = (payMethod === PAY_METHOD_VENDOR || payMethod === PAY_METHOD_CARD_LINK)
    ? f_paymentDetail.value.trim() : "";
  const cardConfirmNote = payMethod === PAY_METHOD_CARD_PAPER
    ? "我已確認對方無法使用匯款付款；我已確認對方無法提供線上刷卡連結" : "";

  const expectedPayoutDate = currentUrgent
    ? f_urgentDate.value
    : (() => {
        const d = computeExpectedPayoutDate(payMethod, new Date());
        return d ? fmtDateYMD(d) : "";
      })();

  const now = new Date().toISOString();
  const record = {
    id: uid(),
    uploader: uploaderSelect.value,
    project: projectSelect.value,
    uploadedAt: now,
    fileDataUrl: selectedImageDataUrl || selectedPdfDataUrl,
    originalFileName: selectedFile ? selectedFile.name : "",
    invoiceDate: f_date.value,
    period: f_period.value,
    amount: Number(f_amount.value),
    vendor: f_vendor.value.trim(),
    items: f_items.value.trim(),
    purpose: f_purpose.value.trim(),
    payMethod: payMethod,
    payee: payee,
    paymentDetail: paymentDetail,
    cardConfirmNote: cardConfirmNote,
    urgent: currentUrgent,
    expectedPayoutDate: expectedPayoutDate,
    confidence: Number(confirmCard.dataset.confidence || 0),
    rawOcrText: currentOcrRawText,
    status: "pending",
    reviewer: "",
    reviewedAt: "",
    rejectReason: "",
    receiptComplete: false,
  };
  record.fileName = suggestFileName(record, record.originalFileName || "receipt.jpg");

  upsertRecord(record);
  showToast("已送出，等待主管審核");

  confirmCard.hidden = true;
  resetFileSelection();
  resetUrgency(); // 避免「緊急」殘留到下一筆
  uploaderSelect.value = uploaderSelect.value; // 保留上傳人，方便連續上傳

  syncRecordToCloud(record, "create");
}

/* ============================================================
   上傳紀錄（唯讀。實際審核動作在 Google 試算表的各專案審核表進行）
   ============================================================ */
function populateRecordFilterOptions() {
  const all = loadRecords();
  const uploaderSel = document.getElementById("mineUploaderFilter");
  const projectSel = document.getElementById("mineProjectFilter");
  const uploaders = [...new Set(all.map(r => r.uploader).filter(Boolean))];
  const projects = [...new Set(all.map(r => r.project).filter(Boolean))];
  const curU = uploaderSel.value, curP = projectSel.value;
  uploaderSel.innerHTML = '<option value="">全部上傳人</option>' + uploaders.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  projectSel.innerHTML = '<option value="">全部專案</option>' + projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  uploaderSel.value = curU;
  projectSel.value = curP;
}
document.getElementById("mineUploaderFilter").addEventListener("change", renderMineView);
document.getElementById("mineProjectFilter").addEventListener("change", renderMineView);
document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
document.getElementById("refreshStatusBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "整理中…";
  await refreshRecordStatuses();
  btn.textContent = originalText;
  btn.disabled = false;
});

function renderMineView() {
  populateRecordFilterOptions();
  const all = loadRecords();

  document.getElementById("statPending").textContent = all.filter(r => r.status === "pending").length;
  document.getElementById("statApproved").textContent = all.filter(r => r.status === "approved").length;
  document.getElementById("statRejected").textContent = all.filter(r => r.status === "rejected").length;

  const filterUploader = document.getElementById("mineUploaderFilter").value;
  const filterProject = document.getElementById("mineProjectFilter").value;
  let records = all;
  if (filterUploader) records = records.filter(r => r.uploader === filterUploader);
  if (filterProject) records = records.filter(r => r.project === filterProject);

  const listEl = document.getElementById("mineList");
  const emptyEl = document.getElementById("mineEmpty");
  if (records.length === 0) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  listEl.innerHTML = records.map(r => recordItemHtml(r, { showUploader: !filterUploader })).join("");
  listEl.querySelectorAll(".record-item").forEach(el => {
    el.addEventListener("click", () => openDetailModal(el.dataset.id, { mode: "view" }));
  });
}

function statusLabel(status) {
  return { pending: "待審核", approved: "已核准", rejected: "已退回" }[status] || status;
}

// 已核准、有期望撥款日期、但憑證正本還沒送到後勤（單據完備=false）時，在紀錄卡片上直接顯示提醒，
// 不另外用通知打擾——使用者明確要求「不要跳出通知，就直接在申請頁面上顯示提醒」。
function receiptReminderHtml(r) {
  if (r.status !== "approved" || r.receiptComplete || !r.expectedPayoutDate) return "";
  return `<div class="confidence-banner mid" style="margin-top:8px;">✅ 已收到您的審核，請於 ${escapeHtml(r.expectedPayoutDate)} 前繳交憑證至後勤人員處</div>`;
}

function recordItemHtml(r, { showUploader }) {
  const lowConfidence = r.confidence && r.confidence < CONFIDENCE_THRESHOLD;
  const syncConfigured = !!loadSyncConfig().enabled;
  const cloudBadge = syncConfigured
    ? `<span class="cloud-badge ${r.cloudSynced ? "synced" : "unsynced"}">${r.cloudSynced ? "☁ 已同步" : "☁ 未同步"}</span>`
    : "";
  return `
    <div class="record-item" data-id="${r.id}">
      <div class="record-main">
        <div class="record-title">${escapeHtml(r.vendor || r.items || "未命名單據")}</div>
        <div class="record-meta">
          ${showUploader ? `<span>${escapeHtml(r.uploader)}</span>` : ""}
          <span>${escapeHtml(r.project)}</span>
          <span>${escapeHtml(r.invoiceDate || "無日期")}</span>
          ${lowConfidence ? `<span style="color:var(--warn)">⚠ 信心分數偏低</span>` : ""}
        </div>
        ${receiptReminderHtml(r)}
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div class="record-amount">${fmtMoney(r.amount)}</div>
        <div>${r.urgent ? `<span class="urgent-badge">緊急</span> ` : ""}<span class="status-badge ${r.status}">${statusLabel(r.status)}</span>${r.paidAt ? ` <span class="paid-badge">💰 已付款</span>` : ""} ${cloudBadge}</div>
      </div>
    </div>`;
}

/* ============================================================
   詳情 / 審核 Modal
   ============================================================ */
const detailModal = document.getElementById("detailModal");
const modalBody = document.getElementById("modalBody");
document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
detailModal.addEventListener("click", (e) => { if (e.target === detailModal) closeModal(); });
function closeModal() { detailModal.hidden = true; modalBody.innerHTML = ""; }

function openDetailModal(id, { mode }) {
  const records = loadRecords();
  const r = records.find(x => x.id === id);
  if (!r) return;

  const imgHtml = r.fileDataUrl ? `<img class="detail-img" src="${r.fileDataUrl}" alt="憑證預覽">` : "";
  const reviewInfo = r.status !== "pending"
    ? `<div class="detail-grid">
         <dt>審核狀態</dt><dd><span class="status-badge ${r.status}">${statusLabel(r.status)}</span></dd>
         <dt>審核人</dt><dd>${escapeHtml(r.reviewer || "—")}</dd>
         <dt>審核時間</dt><dd>${fmtDateTime(r.reviewedAt)}</dd>
         ${r.status === "rejected" ? `<dt>退回原因</dt><dd>${escapeHtml(r.rejectReason || "—")}</dd>` : ""}
       </div>`
    : "";

  modalBody.innerHTML = `
    ${imgHtml}
    <div class="detail-title">${escapeHtml(r.vendor || r.items || "未命名單據")}</div>
    <div class="detail-sub">建議檔名：${escapeHtml(r.fileName || "—")}</div>
    <div class="detail-grid">
      <dt>上傳人</dt><dd>${escapeHtml(r.uploader)}</dd>
      <dt>所屬專案</dt><dd>${escapeHtml(r.project)}</dd>
      <dt>發票日期</dt><dd>${escapeHtml(r.invoiceDate || "—")}</dd>
      <dt>所屬期間</dt><dd>${escapeHtml(r.period || "—")}</dd>
      <dt>金額</dt><dd>${fmtMoney(r.amount)}</dd>
      <dt>發票內容</dt><dd>${escapeHtml(r.items || "—")}</dd>
      <dt>用途說明</dt><dd>${escapeHtml(r.purpose || "—")}</dd>
      <dt>付款方式</dt><dd>${escapeHtml(r.payMethod || "—")}</dd>
      ${r.payee ? `<dt>收款對象</dt><dd>${escapeHtml(r.payee)}</dd>` : ""}
      ${r.paymentDetail ? `<dt>付款資訊</dt><dd>${escapeHtml(r.paymentDetail)}</dd>` : ""}
      <dt>期望撥款日期</dt><dd>${escapeHtml(r.expectedPayoutDate || "—")}</dd>
      <dt>付款日期</dt><dd>${r.paidAt ? escapeHtml(r.paidAt) : "尚未付款"}</dd>
      <dt>急迫性</dt><dd>${r.urgent ? '<span class="urgent-badge">緊急</span>' : "一般"}</dd>
      <dt>單據完備</dt><dd>${r.receiptComplete ? "✅ 已收到正本" : "尚未收到正本"}</dd>
      <dt>辨識信心</dt><dd>${r.confidence ? r.confidence + "%" : "—"}</dd>
      <dt>上傳時間</dt><dd>${fmtDateTime(r.uploadedAt)}</dd>
    </div>
    ${reviewInfo}
    ${receiptReminderHtml(r)}
    ${cloudStatusHtml(r)}
    <div id="modalActions"></div>
  `;

  const retryBtn = document.getElementById("btnRetrySync");
  if (retryBtn) retryBtn.addEventListener("click", async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = "同步中…";
    await syncRecordToCloud(r, r.cloudSynced ? "update" : "create");
    openDetailModal(id, { mode }); // 重新整理畫面顯示最新同步狀態
  });

  // 審核動作已移到 Google 試算表的各專案審核表（由 Sheets 權限控管誰能審），這裡只提供檢視與下載
  const actions = document.getElementById("modalActions");
  if (r.fileDataUrl) {
    actions.innerHTML = `<div class="btn-row"><button class="ghost-btn" id="btnDownload" style="flex:1;">下載憑證檔案（依命名規則）</button></div>`;
    document.getElementById("btnDownload").addEventListener("click", () => downloadRecordFile(r));
  }

  detailModal.hidden = false;
}

function downloadRecordFile(r) {
  if (!r.fileDataUrl) { showToast("此紀錄沒有可下載的檔案"); return; }
  const a = document.createElement("a");
  a.href = r.fileDataUrl;
  a.download = r.fileName || "receipt.jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ============================================================
   CSV 匯出（可貼上 Google 試算表收支表）
   ============================================================ */
function exportCsv() {
  const records = loadRecords();
  if (records.length === 0) { showToast("目前沒有資料可匯出"); return; }
  // 欄位順序對齊 google-sync/Code.gs 的 HEADERS，貼上收支表時才會對到同一欄
  const headers = ["上傳時間", "上傳者", "所屬專案", "發票日期", "金額", "單據內容", "公司名稱", "用途", "所屬期間", "付款方式", "收款對象", "付款資訊", "信用卡紙本確認", "急迫性", "期望撥款日期", "狀態", "審核人", "審核時間", "退回原因", "單據完備", "付款日期", "憑證檔名", "紀錄ID"];
  const rows = records.map(r => [
    fmtDateTimeForSheet(r.uploadedAt), r.uploader, r.project, r.invoiceDate, r.amount,
    r.items, r.vendor, r.purpose, r.period,
    r.payMethod || "", r.payee || "", r.paymentDetail || "", r.cardConfirmNote || "",
    r.urgent ? "緊急" : "一般", r.expectedPayoutDate || "", statusLabel(r.status),
    r.reviewer, fmtDateTimeForSheet(r.reviewedAt), r.rejectReason,
    r.receiptComplete ? "是" : "否", r.paidAt || "", r.fileName, r.id,
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(cellToCsv).join(","))
    .join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `單據收支表_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("已匯出 CSV，可直接匯入 / 貼上 Google 試算表");
}
function cellToCsv(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ============================================================
   雲端同步（Google Apps Script → Google 試算表 / Drive）
   ============================================================ */
const SYNC_CONFIG_KEY = "skillsForU_sync_config_v1";

function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    return raw ? JSON.parse(raw) : { enabled: false, url: "", token: "", cloudOcrEnabled: false };
  } catch (e) {
    return { enabled: false, url: "", token: "", cloudOcrEnabled: false };
  }
}
function saveSyncConfig(config) {
  localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
}

function renderSyncView() {
  const config = loadSyncConfig();
  document.getElementById("syncEnabled").checked = !!config.enabled;
  document.getElementById("syncUrl").value = config.url || "";
  document.getElementById("syncToken").value = config.token || "";
  document.getElementById("cloudOcrEnabled").checked = !!config.cloudOcrEnabled;
  document.getElementById("syncStatusBanner").hidden = true;
  document.getElementById("setupLinkBox").hidden = true;
}

/* 一次性設定連結：把目前已儲存的同步設定編碼進網址參數，同事點開一次就自動套用，
   不用手動貼網址跟密碼。連結本身含密碼，只能私下傳給要用的人，不能公開分享。 */
document.getElementById("generateSetupLinkBtn").addEventListener("click", () => {
  const config = loadSyncConfig();
  if (!config.url) { showToast("請先填寫並儲存雲端同步網址，才能產生設定連結"); return; }
  const params = new URLSearchParams();
  params.set("setup", "1");
  params.set("url", config.url);
  params.set("token", config.token || "");
  if (config.cloudOcrEnabled) params.set("ocr", "1");
  const link = window.location.origin + window.location.pathname + "?" + params.toString();
  const output = document.getElementById("setupLinkOutput");
  output.value = link;
  document.getElementById("setupLinkBox").hidden = false;
});

document.getElementById("copySetupLinkBtn").addEventListener("click", async () => {
  const output = document.getElementById("setupLinkOutput");
  try {
    await navigator.clipboard.writeText(output.value);
    showToast("已複製連結");
  } catch (e) {
    output.focus();
    output.select();
    showToast("無法自動複製，已選取文字，請手動 Cmd/Ctrl+C");
  }
});

/* 頁面載入時檢查網址參數，若是同事點開的一次性設定連結，自動套用並清掉網址列上的密碼 */
function applySetupLinkIfPresent() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("setup") !== "1") return;
  const url = params.get("url") || "";
  if (!url) return;
  saveSyncConfig({
    enabled: true,
    url: url,
    token: params.get("token") || "",
    cloudOcrEnabled: params.get("ocr") === "1",
  });
  showToast("已自動套用雲端同步設定，之後上傳會自動同步");
  window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
}

document.getElementById("saveSyncBtn").addEventListener("click", () => {
  const config = {
    enabled: document.getElementById("syncEnabled").checked,
    url: document.getElementById("syncUrl").value.trim(),
    token: document.getElementById("syncToken").value,
    cloudOcrEnabled: document.getElementById("cloudOcrEnabled").checked,
  };
  saveSyncConfig(config);
  showToast("已儲存雲端同步設定");
});

document.getElementById("testSyncBtn").addEventListener("click", async () => {
  const url = document.getElementById("syncUrl").value.trim();
  const banner = document.getElementById("syncStatusBanner");
  banner.hidden = false;
  banner.className = "confidence-banner mid";
  banner.textContent = "測試連線中…";
  if (!url) {
    banner.className = "confidence-banner low";
    banner.textContent = "請先填寫 Apps Script 網址";
    return;
  }
  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json();
    if (data && data.ok) {
      banner.className = "confidence-banner high";
      // 一併顯示這個「部署版本」實際使用的 OCR 模型，方便確認部署有沒有更新到最新程式碼
      const modelInfo = data.model
        ? `｜此部署使用的 OCR 模型：${data.model}${data.geminiKeySet ? "" : "（⚠ 尚未設定 Gemini 金鑰）"}`
        : "｜⚠ 這個部署版本較舊，沒有回報模型資訊，請到 Apps Script 重新部署「新版本」";
      banner.textContent = "連線成功！" + (data.message || "") + modelInfo;
    } else {
      banner.className = "confidence-banner low";
      banner.textContent = "連線失敗：" + (data && data.error ? data.error : "未知錯誤");
    }
  } catch (err) {
    banner.className = "confidence-banner low";
    banner.textContent = "連線失敗，請確認網址是否正確、是否已部署為「任何人」可存取：" + err.message;
  }
});

function cloudStatusHtml(r) {
  const config = loadSyncConfig();
  if (!config.enabled || !config.url) return "";
  const statusText = r.cloudSynced ? "已同步至 Google 試算表" : (r.cloudError ? "同步失敗：" + escapeHtml(r.cloudError) : "尚未同步");
  const linkHtml = r.cloudFileUrl ? ` ・ <a href="${escapeHtml(r.cloudFileUrl)}" target="_blank" rel="noopener">查看雲端檔案</a>` : "";
  return `
    <div class="confidence-banner ${r.cloudSynced ? "high" : "low"}">
      ☁ ${statusText}${linkHtml}
    </div>
    <div class="btn-row">
      <button class="ghost-btn" id="btnRetrySync" style="flex:1;">${r.cloudSynced ? "重新同步" : "同步至雲端"}</button>
    </div>
  `;
}

function updateRecordCloudStatus(id, patch) {
  const records = loadRecords();
  const r = records.find(x => x.id === id);
  if (!r) return;
  Object.assign(r, patch);
  saveRecords(records);
}

async function syncRecordToCloud(record, action) {
  const config = loadSyncConfig();
  if (!config.enabled || !config.url) return { ok: false, skipped: true };
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // 避免觸發 CORS 預檢，Apps Script 端用 JSON.parse 解析
      body: JSON.stringify({ token: config.token, action, record }),
    });
    const data = await res.json();
    if (data && data.ok) {
      updateRecordCloudStatus(record.id, { cloudSynced: true, cloudFileUrl: data.fileUrl || record.cloudFileUrl || "", cloudError: "" });
    } else {
      updateRecordCloudStatus(record.id, { cloudSynced: false, cloudError: (data && data.error) || "未知錯誤" });
    }
    refreshVisibleListView();
    return data;
  } catch (err) {
    updateRecordCloudStatus(record.id, { cloudSynced: false, cloudError: err.message });
    refreshVisibleListView();
    return { ok: false, error: err.message };
  }
}

function refreshVisibleListView() {
  if (!views.mine.hidden) renderMineView();
}

function statusKeyFromLabel_(label) {
  return { "待審核": "pending", "已核准": "approved", "已退回": "rejected" }[label] || "pending";
}

// 向 Apps Script 要目前總表上每筆單據的真實審核狀態，覆蓋本機記錄。
// 審核動作實際發生在 Google 試算表的專案審核表，這裡只是「拉取」最新結果，不會反過來改到 Sheets。
async function refreshRecordStatuses() {
  const config = loadSyncConfig();
  if (!config.enabled || !config.url) {
    showToast("尚未啟用雲端同步，無法重新整理狀態");
    return;
  }
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: config.token, action: "getStatuses" }),
    });
    const data = await res.json();
    if (!data || !data.ok) {
      showToast("重新整理失敗：" + ((data && data.error) || "未知錯誤"));
      return;
    }
    const records = loadRecords();
    let changed = 0;
    records.forEach((r) => {
      const s = data.statuses[r.id];
      if (!s || !s.status) return;
      const newStatus = statusKeyFromLabel_(s.status);
      if (r.status !== newStatus || r.reviewer !== (s.reviewer || "") ||
          r.rejectReason !== (s.rejectReason || "") || r.paidAt !== (s.paidAt || "") ||
          !!r.receiptComplete !== !!s.receiptComplete) changed++;
      r.status = newStatus;
      r.reviewer = s.reviewer || "";
      r.reviewedAt = s.reviewedAt || "";
      r.rejectReason = s.rejectReason || "";
      r.paidAt = s.paidAt || "";
      r.receiptComplete = !!s.receiptComplete;
    });
    saveRecords(records);
    renderMineView();
    showToast(changed > 0 ? `已更新 ${changed} 筆狀態／付款資訊` : "審核狀態與付款資訊沒有新變動");
  } catch (err) {
    showToast("重新整理失敗：" + err.message);
  }
}

const CLOUD_OCR_TIMEOUT_MS = 45000; // 逾時就直接判定失敗、退回本機離線辨識，避免無上限空等

// data 可以是單一張圖片/PDF 的 dataURL 字串，也可以是多張圖片 dataURL 組成的陣列（PDF 轉圖片後的多頁）
async function cloudOcrRecognize(data) {
  const config = loadSyncConfig();
  if (!config.url) return { ok: false, error: "尚未設定 Apps Script 網址" };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLOUD_OCR_TIMEOUT_MS);
  try {
    const payload = { token: config.token, action: "ocr" };
    if (Array.isArray(data)) payload.imageDataUrls = data; else payload.imageDataUrl = data;
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: `辨識逾時（超過 ${CLOUD_OCR_TIMEOUT_MS / 1000} 秒），已自動取消` };
    }
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ============================================================
   名單設定（上傳人 / 專案）
   ============================================================ */
function renderListsView() {
  // 啟用雲端同步時名單由試算表管理，這裡只做唯讀呈現，避免兩邊各改一份造成不一致
  const cloud = listsManagedByCloud();
  document.getElementById("listsCloudBanner").hidden = !cloud;
  document.getElementById("listsRefreshRow").hidden = !cloud;
  document.getElementById("listsSubtitle").textContent = cloud
    ? "名單來自 Google 試算表，這裡僅供檢視"
    : "管理「上傳人」與「所屬專案」的下拉選單，異動後馬上生效，不需要改程式碼";
  document.querySelectorAll("#view-lists .add-item-row").forEach(el => { el.hidden = cloud; });
  document.querySelector("#view-lists .list-hint").hidden = cloud;

  renderTagList("uploaderTagList", loadUploaders(), cloud ? null : removeUploader);
  renderTagList("projectTagList", loadProjects(), cloud ? null : removeProject);
}

document.getElementById("refreshListsBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "抓取中…";
  const res = await fetchListsFromCloud();
  btn.textContent = original;
  btn.disabled = false;
  renderListsView();
  showToast(res.ok ? "已從試算表更新名單" : "抓取失敗：" + res.error);
});

// onRemove 傳 null＝唯讀模式（名單由試算表管理時），不顯示刪除按鈕
function renderTagList(containerId, items, onRemove) {
  const el = document.getElementById(containerId);
  if (items.length === 0) {
    el.innerHTML = '<div class="tag-list-empty">' +
      (onRemove ? "目前沒有任何項目，請在下面新增" : "目前沒有任何項目，請到 Google 試算表的設定分頁新增") + "</div>";
    return;
  }
  el.innerHTML = items.map(item => `
    <span class="tag-chip" data-value="${escapeHtml(item)}">
      ${escapeHtml(item)}
      ${onRemove ? '<button type="button" title="刪除">✕</button>' : ""}
    </span>
  `).join("");
  if (!onRemove) return;
  el.querySelectorAll(".tag-chip button").forEach(btn => {
    btn.addEventListener("click", () => onRemove(btn.closest(".tag-chip").dataset.value));
  });
}

function addUploader(name) {
  name = name.trim();
  if (!name) return;
  const list = loadUploaders();
  if (list.includes(name)) { showToast("這個人已經在名單裡了"); return; }
  list.push(name);
  saveUploaders(list);
  renderListsView();
  populateUploaderAndProjectSelects();
}
function removeUploader(name) {
  saveUploaders(loadUploaders().filter(u => u !== name));
  renderListsView();
  populateUploaderAndProjectSelects();
}
function addProject(name) {
  name = name.trim();
  if (!name) return;
  const list = loadProjects();
  if (list.includes(name)) { showToast("這個專案已經在名單裡了"); return; }
  list.push(name);
  saveProjects(list);
  renderListsView();
  populateUploaderAndProjectSelects();
}
function removeProject(name) {
  saveProjects(loadProjects().filter(p => p !== name));
  renderListsView();
  populateUploaderAndProjectSelects();
}

document.getElementById("addUploaderBtn").addEventListener("click", () => {
  const input = document.getElementById("newUploaderInput");
  addUploader(input.value);
  input.value = "";
  input.focus();
});
document.getElementById("newUploaderInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addUploaderBtn").click();
});
document.getElementById("addProjectBtn").addEventListener("click", () => {
  const input = document.getElementById("newProjectInput");
  addProject(input.value);
  input.value = "";
  input.focus();
});
document.getElementById("newProjectInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addProjectBtn").click();
});

/* ---------------- 初始化 ---------------- */
applySetupLinkIfPresent();
populateUploaderAndProjectSelects();
switchView("upload");
// 啟用雲端同步時，開頁面就在背景抓一次最新名單；抓不到（離線等）就沿用上次的快取，不擋使用
if (listsManagedByCloud()) fetchListsFromCloud();
