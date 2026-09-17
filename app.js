/* ============================================================
   Skills for U｜核銷小幫手
   純瀏覽器端單據上傳、OCR 辨識（Tesseract.js）與審核小工具。
   資料儲存在 localStorage，沒有後端伺服器；OCR 完全離線執行。
   ============================================================ */

const STORAGE_KEY = "skillsForU_receipts_v1";
const CONFIDENCE_THRESHOLD = 80; // 低於此門檻於畫面上醒目標示，需人工複核（規格書第5節）

const UPLOADERS_KEY = "skillsForU_uploaders_v1";
const PROJECTS_KEY = "skillsForU_projects_v1";
const CENTERS_KEY = "skillsForU_centers_v1"; // string[]，中心名稱清單
const PROJECTS_BY_CENTER_KEY = "skillsForU_projectsByCenter_v1"; // { [中心名稱]: string[] }，專案現在歸在中心底下
const BUDGET_ITEMS_KEY = "skillsForU_budgetItems_v1"; // { [專案名稱]: string[] }，跟名單一樣是雲端快取，離線時仍能沿用上次抓到的
const DEFAULT_UPLOADERS = ["黃偉翔", "胡琬茜", "鐘梓豪", "林新樺", "張晏瑄", "王嘉麗", "羅禎瑩", "李唐", "郭采媛"];
const DEFAULT_PROJECTS = ["組織發展中心", "組織行銷中心", "人才培育中心"];
const DEFAULT_CENTERS = ["組織發展中心", "組織行銷中心", "人才培育中心"];
const DEFAULT_PROJECTS_BY_CENTER = {
  "組織發展中心": ["組織發展中心"],
  "組織行銷中心": ["組織行銷中心"],
  "人才培育中心": ["人才培育中心"],
};
const UNSPECIFIED_BUDGET_ITEM = "不確定預算項目"; // 跟 Code.gs 的 UNSPECIFIED_BUDGET_ITEM 保持一致

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
// 憑證照片的 base64 內容很佔空間，localStorage 通常只有 5~10MB，測試/正式用一陣子很容易爆滿。
// 爆滿時不能整個崩潰讓使用者以為「送出沒反應」——所以分兩層自動搶救：
// 1. 先清掉「已經同步到雲端」那些紀錄的縮圖（Drive 上已經有正本，本機縮圖只是離線快取，清掉不影響資料）。
// 2. 還是不夠的話，連還沒同步的縮圖也一起清（欄位資料不會丟，只是預覽圖跟下載按鈕會失效）。
// 呼叫端要檢查回傳值，在畫面上老實告訴使用者發生了什麼事，不能靜靜吞掉錯誤。
function saveRecords(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return { ok: true };
  } catch (e) {
    if (!(e && (e.name === "QuotaExceededError" || e.code === 22))) {
      console.error("儲存紀錄失敗", e);
      return { ok: false, error: e };
    }
    try {
      const pruned = records.map(r => r.cloudSynced ? { ...r, fileDataUrl: "" } : r);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
      return { ok: true, pruned: true };
    } catch (e2) {
      try {
        const prunedAll = records.map(r => ({ ...r, fileDataUrl: "" }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prunedAll));
        return { ok: true, prunedAll: true };
      } catch (e3) {
        console.error("本機儲存空間不足，清理縮圖後仍無法儲存", e3);
        return { ok: false, error: e3 };
      }
    }
  }
}
function upsertRecord(record) {
  const records = loadRecords();
  const idx = records.findIndex(r => r.id === record.id);
  if (idx >= 0) records[idx] = record; else records.unshift(record);
  return saveRecords(records);
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
function loadCenters() {
  try {
    const raw = localStorage.getItem(CENTERS_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_CENTERS.slice();
  } catch (e) {
    return DEFAULT_CENTERS.slice();
  }
}
function saveCenters(list) {
  localStorage.setItem(CENTERS_KEY, JSON.stringify(list));
}
function loadProjectsByCenter() {
  try {
    const raw = localStorage.getItem(PROJECTS_BY_CENTER_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_PROJECTS_BY_CENTER;
  } catch (e) {
    return DEFAULT_PROJECTS_BY_CENTER;
  }
}
function saveProjectsByCenter(map) {
  localStorage.setItem(PROJECTS_BY_CENTER_KEY, JSON.stringify(map || {}));
}
function loadBudgetItemsByProject() {
  try {
    const raw = localStorage.getItem(BUDGET_ITEMS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function saveBudgetItemsByProject(map) {
  localStorage.setItem(BUDGET_ITEMS_KEY, JSON.stringify(map || {}));
}

// 名單是否由試算表管理（啟用雲端同步就是）
function listsManagedByCloud() {
  const c = loadSyncConfig();
  return !!(c.enabled && c.url);
}

// 從 Apps Script 抓最新名單覆蓋本機快取。回傳是否成功。
async function fetchListsFromCloud() {
  if (!isSignedIn()) return { ok: false, error: "尚未登入" };
  try {
    const data = await cloudPost("getConfig");
    if (!data || !data.ok) return { ok: false, error: (data && data.error) || "未知錯誤" };
    applyCloudConfig(data); // 存名單 + 更新下拉 + 記住登入者
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 專案現在歸在中心底下：先選中心，「所屬專案」下拉再依這個中心過濾。
function populateUploaderAndProjectSelects() {
  const currentUploader = uploaderSelect.value;
  const currentCenter = centerSelect.value;
  uploaderSelect.innerHTML = '<option value="">請選擇上傳人</option>' +
    loadUploaders().map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  centerSelect.innerHTML = '<option value="">請選擇中心</option>' +
    loadCenters().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (loadUploaders().includes(currentUploader)) uploaderSelect.value = currentUploader;
  if (loadCenters().includes(currentCenter)) centerSelect.value = currentCenter;
  populateProjectOptionsForCenter(centerSelect.value);
}

// 依選定的中心，重新產生「所屬專案」下拉；還沒選中心就停用，避免選到不知道歸哪個中心的專案。
function populateProjectOptionsForCenter(centerName) {
  const currentProject = projectSelect.value;
  const projects = centerName ? (loadProjectsByCenter()[centerName] || []) : [];
  projectSelect.disabled = !centerName;
  projectSelect.innerHTML = centerName
    ? '<option value="">請選擇專案</option>' + projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("")
    : '<option value="">請先選擇上方的所屬中心</option>';
  if (projects.includes(currentProject)) projectSelect.value = currentProject;
}

// 預算項目清單依「所屬專案」而定，切換專案時要跟著換選項。
// 沒設定雲端同步、或該專案在「預算項目設定」裡還沒有任何項目時，退回成只有「不確定預算項目」可選，
// 不會擋住上傳（必填規則見 submitRecord），只是那筆之後在對照表裡歸不到細項。
function populateBudgetItemOptions(projectName) {
  const f_budgetItem = document.getElementById("f_budgetItem");
  const current = f_budgetItem.value;
  const items = (loadBudgetItemsByProject()[projectName] || []).slice();
  if (!items.includes(UNSPECIFIED_BUDGET_ITEM)) items.push(UNSPECIFIED_BUDGET_ITEM);
  const placeholder = projectName ? "請選擇預算項目" : "請先選擇上方的所屬專案";
  f_budgetItem.innerHTML = `<option value="">${placeholder}</option>` +
    items.map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join("");
  if (items.includes(current)) f_budgetItem.value = current;
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
};
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  switchView(btn.dataset.view);
});
function switchView(name) {
  Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  // 快取夠新（20 秒內）就直接用快取秒開，太舊才真的重抓一次；
  // 送出單據後那一刻已經在背景偷偷刷新過快取了（見 submitRecord），所以通常切過來就是最新的。
  if (name === "mine") ensureMineDataFresh();
  if (name === "lists") renderListsView();
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
const centerSelect = document.getElementById("centerSelect");
const projectSelect = document.getElementById("projectSelect");
const docTypeSelect = document.getElementById("docTypeSelect");

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
projectSelect.addEventListener("change", () => populateBudgetItemOptions(projectSelect.value));
// 切換中心時，「所屬專案」跟「預算項目」的選項都要跟著重新產生（切中心一定代表換了專案，即使之後選同名的專案也一樣）
centerSelect.addEventListener("change", () => {
  populateProjectOptionsForCenter(centerSelect.value);
  populateBudgetItemOptions(projectSelect.value);
  updateStartButtonState();
});
const noFileBtn = document.getElementById("noFileBtn");
// 「沒有單據」才允許不附檔案：這時候隱藏拖曳區與「開始辨識」，改顯示「直接填寫」；
// 其他單據類型（發票/收據、報價單）一定要附檔案走「開始辨識」。
function updateStartButtonState() {
  const whoReady = uploaderSelect.value && projectSelect.value;
  const isNone = docTypeSelect.value === DOC_TYPE_NONE;
  dropzone.hidden = isNone;
  startOcrBtn.hidden = isNone;
  startOcrBtn.disabled = !(selectedFile && whoReady);
  noFileBtn.hidden = !isNone;
  noFileBtn.disabled = !whoReady;
}
// 沒有單據 → 直接進手動填寫，帶空的辨識結果進確認表單
noFileBtn.addEventListener("click", () => openConfirmForm({ rawText: "", confidenceMean: 0, guesses: {} }));
docTypeSelect.addEventListener("change", () => {
  if (docTypeSelect.value === DOC_TYPE_NONE) resetFileSelection(); // 改成沒有單據就把已選的檔案清掉
  updateStartButtonState();
});

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
  const rawText = f.items ? `（雲端 OCR 摘要）${f.items}` : "（雲端 OCR，未提供原始文字）"; // 只當背景參考文字，不再填進表單欄位
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
    ocrProgressLabel.textContent = "雲端辨識中（Gemini，PDF）…可能需要 1~2 分鐘，請耐心等候";
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
const f_quoteTotal = document.getElementById("f_quoteTotal");
const f_linkedQuote = document.getElementById("f_linkedQuote");
const f_vendor = document.getElementById("f_vendor");
const f_purpose = document.getElementById("f_purpose");
const f_payStatus = document.getElementById("f_payStatus");
const f_payMethod = document.getElementById("f_payMethod");
const f_cardForm = document.getElementById("f_cardForm");
const f_repayTarget = document.getElementById("f_repayTarget");
const f_payeePerson = document.getElementById("f_payeePerson");
const f_payeeVendor = document.getElementById("f_payeeVendor");
const f_paymentDetail = document.getElementById("f_paymentDetail");
const f_cardConfirm1 = document.getElementById("f_cardConfirm1");
const f_cardConfirm2 = document.getElementById("f_cardConfirm2");
const f_urgentDate = document.getElementById("f_urgentDate");

/* 付款方式改成「連動式」，判斷基準是「組織的錢出去了沒」：
   已付款 → 組織信用卡 / 零用金（選完就結束）
   未付款 → 組織匯款 →（外部廠商→填匯款帳號 / 組織人員→選代墊款的人）
            組織信用卡 →（連結→填刷卡連結 / 紙本→勾兩項確認）
   對應後端 Code.gs 的 PAY_STATUS_* / PAY_STATUS_OPTIONS / REPAY_TARGET_* 選項字串，兩邊要一致。 */
const PAY_STATUS_PAID = "已付款";
const PAY_STATUS_UNPAID = "未付款";
const PM_CARD = "組織信用卡";
const PM_PETTY = "零用金";
const PM_TRANSFER = "組織匯款";
const REPAY_MEMBER = "組織人員";
const REPAY_VENDOR = "外部廠商";
const CARD_FORM_LINK = "連結";
const CARD_FORM_PAPER = "紙本";
const PAY_METHODS_BY_STATUS = {
  [PAY_STATUS_PAID]: [PM_CARD, PM_PETTY],
  [PAY_STATUS_UNPAID]: [PM_TRANSFER, PM_CARD],
};

// 只有「未付款」才允許標記緊急：已付款的錢早就出去了，催主管審核不會改變任何事。
function paymentAllowsUrgency_() {
  return f_payStatus.value === PAY_STATUS_UNPAID;
}

f_payStatus.addEventListener("change", onPayStatusChange);
f_payMethod.addEventListener("change", onPayMethodChange);
f_cardForm.addEventListener("change", updatePaymentSubfields);
// 還款對象也會改變撥款日期的推算結果（外部廠商 20 號／組織人員 5 號），
// 光呼叫 updatePaymentSubfields 不會重算，一定要跟著補呼叫 updatePayoutEstimate，
// 不然要等使用者剛好去點一下「審核急迫性」（原本沒事做的按鈕）才會意外觸發到。
f_repayTarget.addEventListener("change", () => { updatePaymentSubfields(); updatePayoutEstimate(); });

// 付款狀態變了 → 重建「付款方式」下拉的選項
function onPayStatusChange() {
  const status = f_payStatus.value;
  const methods = PAY_METHODS_BY_STATUS[status] || [];
  f_payMethod.innerHTML = '<option value="">請選擇付款方式</option>' +
    methods.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  document.getElementById("payMethodField").hidden = !status;
  f_payMethod.value = "";
  onPayMethodChange();
}

function onPayMethodChange() {
  updatePaymentSubfields();
  updateUrgencyVisibility();
  updatePayoutEstimate();
}

// 依「付款狀態 + 付款方式 + 信用卡形式 / 還款對象」決定要顯示哪些細節欄位
function updatePaymentSubfields() {
  const isUnpaid = f_payStatus.value === PAY_STATUS_UNPAID;
  const isTransfer = isUnpaid && f_payMethod.value === PM_TRANSFER;
  const isCardUnpaid = isUnpaid && f_payMethod.value === PM_CARD;

  // 信用卡形式（僅未付款・信用卡）
  document.getElementById("cardFormField").hidden = !isCardUnpaid;
  if (!isCardUnpaid) f_cardForm.value = "";

  // 還款對象（僅未付款・匯款）
  document.getElementById("repayTargetField").hidden = !isTransfer;
  if (!isTransfer) f_repayTarget.value = "";

  const showPerson = isTransfer && f_repayTarget.value === REPAY_MEMBER;
  document.getElementById("payeePersonField").hidden = !showPerson;
  if (showPerson) populatePayeePersonOptions();

  const showVendor = isTransfer && f_repayTarget.value === REPAY_VENDOR;
  document.getElementById("payeeVendorField").hidden = !showVendor;

  // 共用輸入框：外部廠商→匯款帳號；信用卡連結→刷卡連結；其餘隱藏
  const detailField = document.getElementById("paymentDetailField");
  const label = document.getElementById("paymentDetailLabel");
  const hint = document.getElementById("paymentDetailHint");
  if (showVendor) {
    detailField.hidden = false;
    label.innerHTML = '匯款帳號資訊 <span class="req">*</span>';
    f_paymentDetail.placeholder = "銀行／分行、帳號";
    hint.className = "field-hint-example";
    hint.innerHTML = "<strong>範例：</strong>\n華南銀行 城東分行　008_1083\n帳號：94480081415416";
  } else if (isCardUnpaid && f_cardForm.value === CARD_FORM_LINK) {
    detailField.hidden = false;
    label.innerHTML = '刷卡連結 <span class="req">*</span>';
    f_paymentDetail.placeholder = "貼上對方提供的線上刷卡網址";
    hint.className = "field-hint";
    hint.textContent = "範例：https://payment.example.com/pay/abc123";
  } else {
    detailField.hidden = true;
  }

  // 紙本刷卡兩項確認（僅未付款・信用卡・紙本）
  document.getElementById("cardConfirmField").hidden = !(isCardUnpaid && f_cardForm.value === CARD_FORM_PAPER);
}

function populatePayeePersonOptions() {
  const current = f_payeePerson.value;
  const people = loadUploaders();
  f_payeePerson.innerHTML = '<option value="">請選擇代墊款的人</option>' +
    people.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  // 預設帶入登入者本人，但可以改成別人（幫同事代送單據的情況）
  const preferred = people.includes(current) ? current : uploaderSelect.value;
  if (people.includes(preferred)) f_payeePerson.value = preferred;
}

/* ---------------- 單據類型 / 報價單 ----------------
   單據類型在上傳卡片選（發票/收據/報價單）。報價單＝先付款、之後補正式發票。
   「關聯報價單」讓後續款（尾款）掛到同一張報價單的案子底下一起算「已付/尚欠」。 */
const DOC_TYPE_QUOTE = "報價單";
const DOC_TYPE_RECEIPT = "發票 / 收據"; // 發票、收據合成一個選項；只要案子裡有任何一筆是這個，就算「發票已到」。一定要附檔案。
const DOC_TYPE_NONE = "沒有單據";       // 這筆付款沒有任何單據（報價單後續款、之後補發票）。允許不附檔案；不算「發票已到」。
let openQuotesCache = []; // 系統上「未結案」的報價單（單據類型還是報價單、且本身不是別張的後續款）
let quoteRecordsSnapshot = []; // 全部紀錄（含每張報價單底下的後續款），用來即時算「已付多少、會不會超過報價總額」

async function refreshOpenQuotes() {
  if (!isSignedIn()) { openQuotesCache = []; quoteRecordsSnapshot = []; return; }
  try {
    const data = await cloudPost("getAllRecords");
    if (data && data.ok && Array.isArray(data.records)) {
      quoteRecordsSnapshot = data.records;
      openQuotesCache = data.records.filter(r => r.docType === DOC_TYPE_QUOTE && !r.linkedQuoteId);
    }
  } catch (e) { /* 撈不到就沿用上一次的，不擋上傳 */ }
}

// 算某張報價單案子「目前已經付了多少」（母筆 + 所有掛在它底下的後續款），不含現在正在填的這一筆
function quoteCasePaidSoFar(quoteId) {
  return quoteRecordsSnapshot
    .filter(r => r.id === quoteId || r.linkedQuoteId === quoteId)
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
}

// 付款金額會不會「超過」報價總額。回傳超過與否 + 相關數字。只有「超過」才算不符（還沒付完＝正常）。
// 兩種情況都要檢查：
//  (1) 後續款（有選關聯報價單）：之前已付 + 這次 vs 母案報價總額。
//  (2) 報價單母筆（第一次上傳、單據類型＝報價單）：這次付款金額 vs 這張報價單自己填的報價總額
//      ——防止「把本次付款金額和報價總額寫反了」（例如本次 30000、報價總額 5000）卻沒有任何提醒。
function quoteOverpayInfo() {
  const thisAmount = Number(f_amount.value) || 0;
  if (thisAmount <= 0) return { over: false };
  const quoteId = f_linkedQuote.value;
  if (quoteId) {
    const parent = quoteRecordsSnapshot.find(r => r.id === quoteId);
    const total = parent ? Number(parent.quoteTotal) || 0 : 0;
    if (!total) return { over: false };
    const paidBefore = quoteCasePaidSoFar(quoteId);
    return { over: (paidBefore + thisAmount) > total, paidBefore: paidBefore, thisAmount: thisAmount, total: total };
  }
  // 母筆報價單：拿本次付款金額跟這張報價單自己的報價總額比
  if (docTypeSelect.value === DOC_TYPE_QUOTE) {
    const total = Number(f_quoteTotal.value) || 0;
    if (!total) return { over: false };
    return { over: thisAmount > total, paidBefore: 0, thisAmount: thisAmount, total: total };
  }
  return { over: false };
}

// 金額超過報價總額 → 跳出「金額不符原因」必填欄位（填了才能送出）；沒超過就把它收起來。
function updateMismatchField() {
  const field = document.getElementById("mismatchReasonField");
  const banner = document.getElementById("quoteOverpayWarning");
  const info = quoteOverpayInfo();
  if (info.over) {
    field.hidden = false;
    banner.hidden = false;
    banner.textContent = info.paidBefore > 0
      ? `⚠️ 之前已付 NT$${info.paidBefore.toLocaleString("en-US")}，本次 NT$${info.thisAmount.toLocaleString("en-US")}，合計超過報價總額 NT$${info.total.toLocaleString("en-US")}，請填寫不符原因後送出。`
      : `⚠️ 本次付款金額 NT$${info.thisAmount.toLocaleString("en-US")} 超過報價總額 NT$${info.total.toLocaleString("en-US")}，是不是把金額和報價總額寫反了？請確認，或填寫不符原因後送出。`;
  } else {
    field.hidden = true;
    banner.hidden = true;
  }
}
// 輸入金額/報價總額的「過程中」不要每打一個字就判斷——會害不符提醒一直跳出/收起、畫面上下抖動。
// 停手約 0.9 秒才判斷一次。送出時 submitRecord 會再直接檢查一次，不會因為 debounce 漏擋。
let mismatchTimer = null;
function updateMismatchFieldDebounced() {
  clearTimeout(mismatchTimer);
  mismatchTimer = setTimeout(updateMismatchField, 900);
}
f_amount.addEventListener("input", updateMismatchFieldDebounced);
f_quoteTotal.addEventListener("input", updateMismatchFieldDebounced);
f_linkedQuote.addEventListener("change", updateMismatchField); // 下拉選擇是一次性動作，不用 debounce
docTypeSelect.addEventListener("change", updateMismatchField);

function populateLinkedQuoteOptions() {
  const cur = f_linkedQuote.value;
  f_linkedQuote.innerHTML = '<option value="">不是，這是獨立的一筆</option>' +
    openQuotesCache.map(q => {
      const who = q.vendor || q.purpose || q.project || "報價單";
      const total = q.quoteTotal ? `總額 NT$${Number(q.quoteTotal).toLocaleString("en-US")}` : "";
      const label = [who, total, q.uploadedAt].filter(Boolean).join("｜");
      return `<option value="${escapeHtml(q.id)}">${escapeHtml(label)}</option>`;
    }).join("");
  f_linkedQuote.value = cur;
  document.getElementById("linkedQuoteField").hidden = openQuotesCache.length === 0;
}

// 報價總額只在「單據類型＝報價單、且不是別張報價單的後續款」時要填（後續款的總額沿用父案報價）
function updateQuoteFields() {
  const isQuote = docTypeSelect.value === DOC_TYPE_QUOTE;
  document.getElementById("quoteTotalField").hidden = !(isQuote && !f_linkedQuote.value);
  // 報價單相關（不管是母筆還是後續款）都把「金額」欄位的字改成「本次付款金額」，
  // 因為分次付款時這欄裝的只是這一次要付的部分，不是整張報價的總額，字面上要講清楚。
  const isQuoteRelated = isQuote || !!f_linkedQuote.value;
  document.getElementById("f_amountLabelText").textContent = isQuoteRelated ? "本次付款金額" : "金額";
}
f_linkedQuote.addEventListener("change", updateQuoteFields);
docTypeSelect.addEventListener("change", updateQuoteFields);

f_date.addEventListener("change", updatePeriodField);
function updatePeriodField() {
  f_period.value = f_date.value ? f_date.value.slice(0, 7) : "";
}

/* ---------------- 預計撥款日期 ----------------
   組織 5 號／20 號固定發款。以「送出審核當下」而不是發票日期為準：
   - 組織匯款（非組織人員／廠商）：9 號前送出 → 當月 20 號；9 號（含）後 → 次月 20 號
   - 組織匯款（組織人員／同仁代墊）：9 號前送出 → 次月 5 號；9 號（含）後 → 次次月 5 號
   其他付款方式（零用金／信用卡）沒有固定發款週期規則，不自動推算。
   標記緊急時，改用上傳人自己選的「希望完成付款日期」，不套用這個公式。 */
function computeExpectedPayoutDate(payStatus, payMethod, repayTarget, submitDate) {
  // 只有「未付款・組織匯款」有固定發款週期；其餘（已付款、信用卡）不自動推算
  if (payStatus !== PAY_STATUS_UNPAID || payMethod !== PM_TRANSFER) return null;
  const day = submitDate.getDate();
  const y = submitDate.getFullYear();
  const m = submitDate.getMonth();
  if (repayTarget === REPAY_VENDOR) {
    return new Date(y, day <= 9 ? m : m + 1, 20);
  }
  if (repayTarget === REPAY_MEMBER) {
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
    banner.hidden = true; // 緊急件的日期由「希望完成付款日期」欄位處理，不重複顯示這個提示
    return;
  }
  const estimated = computeExpectedPayoutDate(f_payStatus.value, f_payMethod.value, f_repayTarget.value, new Date());
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

// 切換到不支援急迫性的付款方式時，順手把已經選好的「緊急」清掉，
// 避免使用者先勾了緊急、再改付款方式，結果送出一筆看不見卻標著緊急的紀錄。
function updateUrgencyVisibility() {
  const allowed = paymentAllowsUrgency_();
  document.getElementById("urgencyField").hidden = !allowed;
  if (!allowed) resetUrgency();
}

function openConfirmForm({ rawText, confidenceMean, guesses }) {
  currentOcrRawText = rawText;
  rawOcrText.textContent = rawText || "（此檔案未執行文字辨識，請手動輸入欄位）";

  f_date.value = guesses.date || "";
  updatePeriodField();
  f_amount.value = guesses.amount || "";
  f_vendor.value = guesses.vendor || "";
  f_purpose.value = "";
  populateBudgetItemOptions(projectSelect.value); // 專案在上傳這步就選好了，這裡直接依它填出對應的預算項目清單
  f_payStatus.value = "";
  f_cardForm.value = "";
  f_repayTarget.value = "";
  f_payeeVendor.value = "";
  f_paymentDetail.value = "";
  f_cardConfirm1.checked = false;
  f_cardConfirm2.checked = false;
  onPayStatusChange(); // 重建付款方式下拉、收起所有細節欄位、重算緊急與撥款預估
  resetUrgency();
  updateUrgencyVisibility();

  // 報價單相關：報價總額、關聯報價單（後續款）
  f_quoteTotal.value = "";
  f_linkedQuote.value = "";
  updateQuoteFields();
  document.getElementById("f_mismatchReason").value = "";
  document.getElementById("mismatchReasonField").hidden = true;
  document.getElementById("quoteOverpayWarning").hidden = true;
  refreshOpenQuotes().then(() => { populateLinkedQuoteOptions(); updateQuoteFields(); updateMismatchField(); });

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
  // record.invoiceDate 是 "YYYY-MM-DD"，去掉連字號變成 "YYYYMMDD"
  const ymd = record.invoiceDate ? record.invoiceDate.replace(/-/g, "") : "未知日期";
  return `${ymd}_${record.amount || 0}元${ext}`;
}

function submitRecord() {
  const docType = docTypeSelect.value || DOC_TYPE_RECEIPT;
  const linkedQuoteId = f_linkedQuote.value || "";

  if (!f_date.value) { showToast("請填寫發票 / 收據日期"); f_date.focus(); return; }
  if (!f_amount.value || Number(f_amount.value) <= 0) { showToast("請填寫金額"); f_amount.focus(); return; }
  if (!f_purpose.value.trim()) { showToast("請填寫活動／用途說明"); f_purpose.focus(); return; }
  const f_budgetItem = document.getElementById("f_budgetItem");
  if (!f_budgetItem.value) { showToast("請選擇預算項目（真的不知道可以選「不確定預算項目」）"); f_budgetItem.focus(); return; }

  // 沒傳檔案：只有「單據類型＝沒有單據」才允許不附檔；發票/收據、報價單一定要有憑證檔。
  const hasFile = !!(selectedImageDataUrl || selectedPdfDataUrl);
  if (!hasFile && docType !== DOC_TYPE_NONE) {
    showToast("請先上傳憑證檔案（若這筆真的沒有單據，請把「單據類型」改成『沒有單據』）");
    return;
  }
  // 「沒有單據」一定要掛在某張報價單底下（它就是「報價單的後續款、之後補發票」），不能是獨立一筆
  if (docType === DOC_TYPE_NONE && !linkedQuoteId) {
    showToast("「沒有單據」必須選擇它是哪一張報價單的後續款，不能是獨立的一筆");
    f_linkedQuote.focus(); return;
  }
  let quoteTotal = "";
  if (docType === DOC_TYPE_QUOTE && !linkedQuoteId) {
    if (!f_quoteTotal.value || Number(f_quoteTotal.value) <= 0) {
      showToast("報價單請填「報價總額」"); f_quoteTotal.focus(); return;
    }
    quoteTotal = Number(f_quoteTotal.value);
  } else if (linkedQuoteId) {
    // 後續款（訂金/尾款）也把原本那張報價單的報價總額一起帶進去，純粹是方便財務在總表
    // 對帳時，同一個案子的每一列都看得到報價總額是多少，不用另外回頭找母筆——
    // 不是新的「真相來源」，真正的總額還是以母筆那筆為準，這裡只是複製一份方便查看。
    const parentQuote = quoteRecordsSnapshot.find(r => r.id === linkedQuoteId);
    if (parentQuote && parentQuote.quoteTotal) quoteTotal = Number(parentQuote.quoteTotal);
  }

  const payStatus = f_payStatus.value;
  if (!payStatus) { showToast("請選擇付款狀態"); f_payStatus.focus(); return; }
  const payMethod = f_payMethod.value;
  if (!payMethod) { showToast("請選擇付款方式"); f_payMethod.focus(); return; }

  const isUnpaid = payStatus === PAY_STATUS_UNPAID;
  const isTransfer = isUnpaid && payMethod === PM_TRANSFER;
  const isCardUnpaid = isUnpaid && payMethod === PM_CARD;
  let repayTarget = "";
  let cardForm = "";

  if (isTransfer) {
    repayTarget = f_repayTarget.value;
    if (!repayTarget) { showToast("請選擇還款對象"); f_repayTarget.focus(); return; }
    if (repayTarget === REPAY_MEMBER && !f_payeePerson.value) {
      showToast("請選擇代墊款的人"); f_payeePerson.focus(); return;
    }
    if (repayTarget === REPAY_VENDOR) {
      if (!f_payeeVendor.value.trim()) { showToast("請填寫戶名"); f_payeeVendor.focus(); return; }
      if (!f_paymentDetail.value.trim()) { showToast("請填寫匯款帳號資訊"); f_paymentDetail.focus(); return; }
    }
  }
  if (isCardUnpaid) {
    cardForm = f_cardForm.value;
    if (!cardForm) { showToast("請選擇信用卡付款方式（連結或紙本）"); f_cardForm.focus(); return; }
    if (cardForm === CARD_FORM_LINK && !f_paymentDetail.value.trim()) {
      showToast("請填寫刷卡連結"); f_paymentDetail.focus(); return;
    }
    if (cardForm === CARD_FORM_PAPER && (!f_cardConfirm1.checked || !f_cardConfirm2.checked)) {
      showToast("請勾選兩項確認後才能送出（信用卡紙本付款須先確認無法匯款、無法線上刷卡）");
      return;
    }
  }
  // 只有未付款才允許緊急；即使切換過程殘留勾選，已付款一律視為一般
  const urgent = paymentAllowsUrgency_() && currentUrgent;
  if (urgent && !f_urgentDate.value) {
    showToast("標記緊急時，請選擇希望完成付款日期"); f_urgentDate.focus(); return;
  }

  // 金額超過報價總額 → 必填「不符原因」（追加或算錯都在這裡說明，不擋送出，只要有填就好）
  const overpay = quoteOverpayInfo();
  const mismatchReason = document.getElementById("f_mismatchReason").value.trim();
  if (overpay.over && !mismatchReason) {
    showToast("本次金額超過報價總額，請填寫「金額不符原因」後再送出");
    document.getElementById("f_mismatchReason").focus();
    return;
  }

  // 收款對象：匯款・組織人員記人名、匯款・外部廠商記戶名，其他情況無（款項已由組織支付／刷卡）
  const payee = isTransfer
    ? (repayTarget === REPAY_MEMBER ? f_payeePerson.value : f_payeeVendor.value.trim())
    : "";
  const paymentDetail = (isTransfer && repayTarget === REPAY_VENDOR) ? f_paymentDetail.value.trim()
    : (isCardUnpaid && cardForm === CARD_FORM_LINK) ? f_paymentDetail.value.trim()
    : "";
  // 「確認事項」一欄身兼兩用：信用卡紙本的兩項確認、以及報價金額不符原因。
  // 兩者幾乎不會同時發生，真的同時就把兩段用換行接起來放同一欄。
  const cardConfirmText = (isCardUnpaid && cardForm === CARD_FORM_PAPER)
    ? "我已確認對方無法使用匯款付款；我已確認對方無法提供線上刷卡連結" : "";
  const confirmNote = [cardConfirmText, (overpay.over ? mismatchReason : "")].filter(Boolean).join("\n");

  const expectedPayoutDate = urgent
    ? f_urgentDate.value
    : (() => {
        const d = computeExpectedPayoutDate(payStatus, payMethod, repayTarget, new Date());
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
    purpose: f_purpose.value.trim(),
    budgetItem: f_budgetItem.value,
    docType: docType,
    quoteTotal: quoteTotal,
    linkedQuoteId: linkedQuoteId,
    payStatus: payStatus,
    payMethod: payMethod,
    cardForm: cardForm,
    repayTarget: repayTarget,
    payee: payee,
    paymentDetail: paymentDetail,
    confirmNote: confirmNote,
    urgent: urgent,
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

  const saveResult = upsertRecord(record);
  if (!saveResult.ok) {
    // 真的救不回來：不要清空表單，讓使用者可以重試或先手動清理舊紀錄，資料不會憑空消失
    showToast("送出失敗：瀏覽器本機儲存空間已滿，請到「上傳紀錄」清理較舊的項目後再試一次");
    return;
  }
  if (saveResult.prunedAll) {
    showToast("已送出，但本機空間不足，已自動清除本機縮圖（雲端資料不受影響，已同步的可到雲端硬碟查看）");
  } else if (saveResult.pruned) {
    showToast("已送出，等待主管審核（已自動清理部分舊縮圖騰出空間）");
  } else {
    showToast("已送出，等待主管審核");
  }

  confirmCard.hidden = true;
  resetFileSelection();
  resetUrgency(); // 避免「緊急」殘留到下一筆
  uploaderSelect.value = uploaderSelect.value; // 保留上傳人，方便連續上傳

  syncRecordToCloud(record, "create").then((res) => {
    // 送出成功的話，順手在背景把「上傳紀錄」的快取刷新一次（不擋畫面、不用等），
    // 這樣等使用者真的點過去看時，這筆多半已經在正式清單裡了，不會卡在「未同步」的過渡狀態。
    if (res && res.ok) loadAllRecordsFromCloud();
  });
}

/* ============================================================
   上傳紀錄（唯讀。實際審核動作在 Google 試算表的各專案審核表進行）
   ============================================================ */
/* ============================================================
   上傳紀錄（v2：以「收支總表」為主，看得到所有人的紀錄，可依上傳人／日期區間篩選）
   ============================================================ */
let serverRecords = null; // 從後端 getAllRecords 撈回來的全部紀錄（null＝還沒載過）
let mineDisplay = [];     // 目前畫面上（合併未同步本機 + 篩選後）的清單，供 modal 依 id 查

// 統一狀態表示：後端回傳中文（待審核…），本機用英文 key（pending…）
function recStatusKey(r) {
  return r._localOnly ? (r.status || "pending") : statusKeyFromLabel_(r.status || "待審核");
}
// 統一取「上傳日期」YYYY-MM-DD（後端是 "YYYY-MM-DD HH:mm"，本機是 ISO）
function uploadDateOf(r) {
  const s = String(r.uploadedAt || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : fmtDateYMD(d);
}
// 合併：後端全部 + 本機「還沒同步成功」的（後端找不到、且 cloudSynced 不是 true）。
// ⚠️ 關鍵：只補「真的還沒同步成功」的本機紀錄。已經同步成功過(cloudSynced=true)卻在後端找不到的，
//    代表它是在總表被刪掉了——這種就不要再顯示（不然會變成刪不掉的幽靈一直掛著）。
function mergedRecords() {
  const server = serverRecords || [];
  const ids = new Set(server.map(r => r.id));
  const localOnly = loadRecords()
    .filter(r => !ids.has(r.id) && !r.cloudSynced)
    .map(r => Object.assign({}, r, { _localOnly: true }));
  return server.concat(localOnly);
}

// 每次成功跟後端拿到最新清單後，把本機那些「已經同步成功」的紀錄清掉：
// 它們該有的資料都在後端了，本機留著只會佔空間、還會在總表被刪掉後變成幽靈。
// 只保留「還沒同步成功」的，讓它們還能顯示成未同步、之後可重試。
function pruneSyncedLocalRecords() {
  const records = loadRecords();
  const keep = records.filter(r => !r.cloudSynced);
  if (keep.length !== records.length) saveRecords(keep);
}

let lastRecordsLoadedAt = 0;
const RECORDS_CACHE_MS = 20000; // 20 秒內重複切回這頁直接用快取秒開，不用每次都整個重抓（Apps Script 這一趟常常要等好幾秒）

// 切到「上傳紀錄」時呼叫：快取夠新就直接用快取秒開；太舊或還沒載過才真的去後端要一次。
function ensureMineDataFresh() {
  if (serverRecords === null || Date.now() - lastRecordsLoadedAt > RECORDS_CACHE_MS) {
    loadAllRecordsFromCloud();
  } else {
    renderMineView();
  }
}

async function loadAllRecordsFromCloud() {
  if (!isSignedIn()) { showToast("尚未登入"); return; }
  // 已經有舊資料的話，先把舊清單維持顯示，只在上面加一個小提示，不要整個清空變白——
  // 不然每次重新整理都像「卡住了」，這正是使用者反映「等很久看起來沒反應」的原因之一。
  const loadingHint = document.getElementById("mineLoadingHint");
  if (loadingHint) loadingHint.hidden = false;
  const data = await cloudPost("getAllRecords");
  if (loadingHint) loadingHint.hidden = true;
  if (!data || !data.ok) { showToast("載入失敗：" + ((data && data.error) || "未知錯誤")); return; }
  serverRecords = Array.isArray(data.records) ? data.records : [];
  lastRecordsLoadedAt = Date.now();
  pruneSyncedLocalRecords(); // 清掉本機已同步的殘留（含被總表刪掉的幽靈）
  renderMineView();
}

function populateRecordFilterOptionsFrom(all) {
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
document.getElementById("mineDateFrom").addEventListener("change", renderMineView);
document.getElementById("mineDateTo").addEventListener("change", renderMineView);
document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
document.getElementById("refreshStatusBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "載入中…";
  await loadAllRecordsFromCloud();
  btn.textContent = originalText;
  btn.disabled = false;
});

// 清除本機暫存：把這台瀏覽器 localStorage 裡的紀錄全部清掉（不會動到雲端/總表的任何資料）。
// 主要用途：清掉那些「總表已刪、本機還掛著」的舊測試資料。已同步的清掉沒差（雲端還有）；
// 若有還沒同步成功的，清掉那幾筆就真的沒了，所以警語先數給使用者看。
document.getElementById("clearLocalBtn").addEventListener("click", () => {
  const records = loadRecords();
  if (records.length === 0) { showToast("目前沒有本機暫存可清除"); return; }
  const unsynced = records.filter(r => !r.cloudSynced).length;
  const warn = unsynced > 0
    ? `其中有 ${unsynced} 筆還沒同步成功，清除後這幾筆會真的消失、無法復原。`
    : `這些都已經同步到雲端，清除本機不影響總表/雲端資料。`;
  if (!window.confirm(`確定清除這台瀏覽器上的 ${records.length} 筆本機暫存嗎？\n\n${warn}\n\n（不會動到總表/雲端）`)) return;
  localStorage.removeItem(STORAGE_KEY);
  loadAllRecordsFromCloud();
  showToast("已清除本機暫存");
});

function renderMineView() {
  if (serverRecords === null) {
    // 第一次進來自動載入
    const emptyEl = document.getElementById("mineEmpty");
    document.getElementById("mineList").innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "載入中…";
    loadAllRecordsFromCloud();
    return;
  }
  const all = mergedRecords();
  populateRecordFilterOptionsFrom(all);

  document.getElementById("statPending").textContent = all.filter(r => recStatusKey(r) === "pending").length;
  document.getElementById("statApproved").textContent = all.filter(r => recStatusKey(r) === "approved").length;
  document.getElementById("statRejected").textContent = all.filter(r => recStatusKey(r) === "rejected").length;

  const fU = document.getElementById("mineUploaderFilter").value;
  const fP = document.getElementById("mineProjectFilter").value;
  const fFrom = document.getElementById("mineDateFrom").value;
  const fTo = document.getElementById("mineDateTo").value;
  let records = all;
  if (fU) records = records.filter(r => r.uploader === fU);
  if (fP) records = records.filter(r => r.project === fP);
  if (fFrom) records = records.filter(r => uploadDateOf(r) && uploadDateOf(r) >= fFrom);
  if (fTo) records = records.filter(r => uploadDateOf(r) && uploadDateOf(r) <= fTo);

  renderQuoteCases(all); // 報價單案子用未篩選的全部算，才不會因篩選漏算已付

  mineDisplay = records;
  const listEl = document.getElementById("mineList");
  const emptyEl = document.getElementById("mineEmpty");
  if (records.length === 0) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = all.length === 0 ? "目前還沒有任何上傳紀錄" : "沒有符合篩選條件的紀錄";
    return;
  }
  emptyEl.hidden = true;
  listEl.innerHTML = records.map(r => recordItemHtml(r, { showUploader: !fU })).join("");
  listEl.querySelectorAll(".record-item").forEach(el => {
    el.addEventListener("click", () => openDetailModal(el.dataset.id));
  });
}

// 報價單案子：一張報價單（母）＋所有掛在它底下的後續款。顯示報價總額／已付／尚欠；
// 只要案子裡「還沒有任何一筆是發票/收據」就顯示「⚠️ 發票還沒來」並給補發票入口。
// 已經有發票、而且尚欠 0 的案子＝結清，不再列在這區（避免越積越長）。
function renderQuoteCases(all) {
  const section = document.getElementById("quoteCasesSection");
  const listEl = document.getElementById("quoteCasesList");
  const cases = all
    .filter(r => r.docType === DOC_TYPE_QUOTE && !r.linkedQuoteId)
    .map(p => {
      const children = all.filter(r => r.linkedQuoteId === p.id);
      const paid = [p].concat(children).reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const total = Number(p.quoteTotal) || 0;
      const hasInvoice = children.some(c => c.docType === DOC_TYPE_RECEIPT);
      return { p: p, children: children, paid: paid, total: total, remain: Math.max(total - paid, 0), hasInvoice: hasInvoice };
    })
    .filter(c => !c.hasInvoice || c.remain > 0); // 已補發票又付清＝結清，不再顯示
  if (cases.length === 0) { section.hidden = true; listEl.innerHTML = ""; return; }
  section.hidden = false;
  listEl.innerHTML = cases.map(c => {
    const who = c.p.vendor || c.p.purpose || c.p.project || "報價單";
    const warn = c.hasInvoice ? "" : `<span class="quote-case-warn">⚠️ 發票還沒來</span>`;
    const attachBtn = c.hasInvoice ? "" : `<button class="ghost-btn ghost-btn-sm" data-attach="${escapeHtml(c.p.id)}">補上發票</button>`;
    return `
      <div class="quote-case">
        <div class="quote-case-head">
          <div class="quote-case-title">${escapeHtml(who)} <span class="quote-case-proj">${escapeHtml(c.p.project || "")}</span> ${warn}</div>
          ${attachBtn}
        </div>
        <div class="quote-case-nums">
          <span>報價總額 <b>${fmtMoney(c.total)}</b></span>
          <span>已付 <b>${fmtMoney(c.paid)}</b>${c.children.length ? `（含 ${c.children.length} 筆後續款）` : ""}</span>
          <span class="${c.remain > 0 ? "remain-pos" : "remain-zero"}">尚欠 <b>${fmtMoney(c.remain)}</b></span>
        </div>
      </div>`;
  }).join("");
  listEl.querySelectorAll("[data-attach]").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); openAttachInvoice(btn.dataset.attach); });
  });
}

/* ---- 補上發票：就只是「把正式發票 / 收據這份憑證掛到這張報價單」而已，不涉及付款。
   所以不問金額（金額固定 0）——要付錢請走正常上傳流程（單據類型選發票/收據、選關聯報價單、填金額）。---- */
let attachFile = { dataUrl: "", name: "" };
function openAttachInvoice(caseId) {
  const p = (serverRecords || []).find(r => r.id === caseId);
  if (!p) { showToast("找不到這張報價單"); return; }
  attachFile = { dataUrl: "", name: "" };
  modalBody.innerHTML = `
    <div class="detail-title">補上正式發票 / 收據</div>
    <div class="detail-sub">${escapeHtml(p.vendor || p.purpose || "報價單")}｜報價總額 ${fmtMoney(Number(p.quoteTotal) || 0)}</div>
    <p class="field-hint" style="margin-top:8px;">把正式發票 / 收據掛到這張報價單當憑證，不涉及付款。若還有款項要付，請走正常的「上傳單據」流程。</p>
    <label class="field-label" style="margin-top:10px;">正式發票 / 收據檔案 <span class="req">*</span></label>
    <input type="file" id="attachFileInput" accept="image/*,.pdf" class="text-input">
    <label class="field-label">發票 / 收據日期</label>
    <input type="date" id="attachDate" class="text-input">
    <div class="btn-row"><button class="primary-btn" id="attachSubmitBtn" style="flex:1;">送出</button></div>
  `;
  document.getElementById("attachFileInput").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { attachFile = { dataUrl: reader.result, name: f.name }; };
    reader.readAsDataURL(f);
  });
  document.getElementById("attachSubmitBtn").addEventListener("click", () => submitAttachInvoice(p));
  detailModal.hidden = false;
}

async function submitAttachInvoice(p) {
  if (!attachFile.dataUrl) { showToast("請先選擇正式發票 / 收據檔案"); return; }
  const invoiceDate = document.getElementById("attachDate").value;
  const record = {
    id: uid(),
    uploader: (currentUser && currentUser.name) || "",
    project: p.project,
    uploadedAt: new Date().toISOString(),
    fileDataUrl: attachFile.dataUrl,
    originalFileName: attachFile.name,
    fileName: attachFile.name,
    invoiceDate: invoiceDate,
    period: invoiceDate ? invoiceDate.slice(0, 7) : (p.period || ""),
    amount: 0, // 補發票只是掛憑證，不涉及付款
    vendor: p.vendor || "",
    purpose: p.purpose || "",
    budgetItem: p.budgetItem || "",
    docType: DOC_TYPE_RECEIPT,
    quoteTotal: Number(p.quoteTotal) || "",
    linkedQuoteId: p.id,
    payStatus: "", payMethod: "", cardForm: "", repayTarget: "", payee: "", paymentDetail: "",
    confirmNote: "",
    urgent: false, expectedPayoutDate: "",
    status: "pending", reviewer: "", reviewedAt: "", rejectReason: "", receiptComplete: false,
  };
  const btn = document.getElementById("attachSubmitBtn");
  btn.disabled = true; btn.textContent = "送出中…";
  const data = await cloudPost("create", { record: record });
  if (!data || !data.ok) { btn.disabled = false; btn.textContent = "送出"; showToast("補件失敗：" + ((data && data.error) || "未知錯誤")); return; }
  closeModal();
  showToast("已補上正式發票");
  loadAllRecordsFromCloud();
}

function statusLabel(status) {
  return { pending: "待審核", approved: "已核准", rejected: "已退回" }[status] || status;
}

// 已核准、有期望撥款日期、但憑證正本還沒送到後勤（單據完備=false）時，在紀錄卡片上直接顯示提醒
function receiptReminderHtml(r, sk) {
  if (sk !== "approved" || r.receiptComplete || !r.expectedPayoutDate) return "";
  return `<div class="confidence-banner mid" style="margin-top:8px;">✅ 已收到您的審核，請於 ${escapeHtml(r.expectedPayoutDate)} 前繳交憑證至後勤人員處</div>`;
}

function recordItemHtml(r, { showUploader }) {
  const sk = recStatusKey(r);
  const lowConfidence = r.confidence && r.confidence < CONFIDENCE_THRESHOLD;
  // 從後端撈回來的紀錄一定是已經同步的（不然不會在清單裡）；本機這台瀏覽器剛送出、
  // 還沒出現在後端清單裡的（_localOnly），要看 r.cloudSynced 才知道實際同不同步。
  // 之前拿掉的只是「（清單尚待整理）」那句過渡文字，不是整個「已同步」圖示，這裡補回來。
  const cloudBadge = (r._localOnly && !r.cloudSynced)
    ? `<span class="cloud-badge unsynced">☁ 未同步</span>`
    : `<span class="cloud-badge synced">☁ 已同步</span>`;
  // 一般的「發票 / 收據」不特別標；報價單、沒有單據才加徽章提醒
  const docBadge = (r.docType && r.docType !== DOC_TYPE_RECEIPT) ? `<span class="doc-badge">${escapeHtml(r.docType)}</span> ` : "";
  return `
    <div class="record-item" data-id="${escapeHtml(r.id)}">
      <div class="record-main">
        <div class="record-title">${docBadge}${escapeHtml(r.vendor || r.purpose || "未命名單據")}</div>
        <div class="record-meta">
          ${showUploader ? `<span>${escapeHtml(r.uploader)}</span>` : ""}
          <span>${escapeHtml(r.project)}</span>
          <span>${escapeHtml(r.invoiceDate || "無日期")}</span>
          ${lowConfidence ? `<span style="color:var(--warn)">⚠ 信心分數偏低</span>` : ""}
        </div>
        ${receiptReminderHtml(r, sk)}
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div class="record-amount">${fmtMoney(r.amount)}</div>
        <div>${r.urgent ? `<span class="urgent-badge">緊急</span> ` : ""}<span class="status-badge ${sk}">${statusLabel(sk)}</span>${r.paidAt ? ` <span class="paid-badge">💰 已付款</span>` : ""} ${cloudBadge}</div>
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

function openDetailModal(id) {
  const r = mineDisplay.find(x => x.id === id) || (serverRecords || []).find(x => x.id === id) || loadRecords().find(x => x.id === id);
  if (!r) return;
  const sk = recStatusKey(r);

  // 本機剛上傳的有縮圖(fileDataUrl)；從雲端撈回來的只有雲端連結(fileUrl)
  const imgHtml = r.fileDataUrl
    ? `<img class="detail-img" src="${r.fileDataUrl}" alt="憑證預覽">`
    : (r.fileUrl ? `<p class="field-hint"><a href="${escapeHtml(r.fileUrl)}" target="_blank" rel="noopener">🔗 查看雲端憑證檔案</a></p>` : "");
  const reviewInfo = sk !== "pending"
    ? `<div class="detail-grid">
         <dt>審核狀態</dt><dd><span class="status-badge ${sk}">${statusLabel(sk)}</span></dd>
         <dt>審核人</dt><dd>${escapeHtml(r.reviewer || "—")}</dd>
         <dt>審核時間</dt><dd>${fmtDateTime(r.reviewedAt)}</dd>
         ${sk === "rejected" ? `<dt>退回原因</dt><dd>${escapeHtml(r.rejectReason || "—")}</dd>` : ""}
       </div>`
    : "";

  const payDesc = [r.payStatus, r.payMethod, r.cardForm, r.repayTarget].filter(Boolean).join(" · ") || "—";
  const isQuote = r.docType === DOC_TYPE_QUOTE;

  modalBody.innerHTML = `
    ${imgHtml}
    <div class="detail-title">${isQuote ? '<span class="doc-badge">報價單</span> ' : ""}${escapeHtml(r.vendor || r.purpose || "未命名單據")}</div>
    <div class="detail-sub">建議檔名：${escapeHtml(r.fileName || "—")}</div>
    <div class="detail-grid">
      <dt>上傳人</dt><dd>${escapeHtml(r.uploader)}</dd>
      <dt>所屬專案</dt><dd>${escapeHtml(r.project)}</dd>
      <dt>單據類型</dt><dd>${escapeHtml(r.docType || DOC_TYPE_RECEIPT)}</dd>
      <dt>發票日期</dt><dd>${escapeHtml(r.invoiceDate || "—")}</dd>
      <dt>${isQuote ? "本次金額" : "金額"}</dt><dd>${fmtMoney(r.amount)}</dd>
      ${(isQuote || r.linkedQuoteId) ? `<dt>報價總額</dt><dd>${fmtMoney(Number(r.quoteTotal) || 0)}</dd>` : ""}
      <dt>用途說明</dt><dd>${escapeHtml(r.purpose || "—")}</dd>
      <dt>預算項目</dt><dd>${escapeHtml(r.budgetItem || "—")}</dd>
      <dt>付款方式</dt><dd>${escapeHtml(payDesc)}</dd>
      ${r.payee ? `<dt>收款對象</dt><dd>${escapeHtml(r.payee)}</dd>` : ""}
      ${r.paymentDetail ? `<dt>付款資訊</dt><dd>${escapeHtml(r.paymentDetail)}</dd>` : ""}
      ${r.confirmNote ? `<dt>確認事項</dt><dd>${escapeHtml(r.confirmNote)}</dd>` : ""}
      <dt>期望撥款日期</dt><dd>${escapeHtml(r.expectedPayoutDate || "—")}</dd>
      <dt>付款日期</dt><dd>${r.paidAt ? escapeHtml(r.paidAt) : "尚未付款"}</dd>
      <dt>急迫性</dt><dd>${r.urgent ? '<span class="urgent-badge">緊急</span>' : "一般"}</dd>
      <dt>單據完備</dt><dd>${r.receiptComplete ? "✅ 已收到正本" : "尚未收到正本"}</dd>
      <dt>上傳時間</dt><dd>${fmtDateTime(r.uploadedAt)}</dd>
    </div>
    ${reviewInfo}
    ${receiptReminderHtml(r, sk)}
    ${r._localOnly ? cloudStatusHtml(r) : ""}
    <div id="modalActions"></div>
  `;

  // 未同步的本機紀錄才有「同步至雲端」重試按鈕
  const retryBtn = document.getElementById("btnRetrySync");
  if (retryBtn) retryBtn.addEventListener("click", async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = "同步中…";
    await syncRecordToCloud(r, "create");
    openDetailModal(id);
  });

  // 只有「報價單母筆、且案子還沒有任何發票/收據」才在詳情裡放「補上發票」入口
  const actions = document.getElementById("modalActions");
  let actionsHtml = "";
  const isQuoteParent = isQuote && !r.linkedQuoteId && !r._localOnly;
  const caseHasInvoice = isQuoteParent && (serverRecords || []).some(x => x.linkedQuoteId === r.id && x.docType === DOC_TYPE_RECEIPT);
  if (isQuoteParent && !caseHasInvoice) {
    actionsHtml += `<div class="btn-row"><button class="primary-btn" id="btnAttachInvoice" style="flex:1;">補上正式發票</button></div>`;
  }
  if (r.fileDataUrl) {
    actionsHtml += `<div class="btn-row"><button class="ghost-btn" id="btnDownload" style="flex:1;">下載憑證檔案（依命名規則）</button></div>`;
  }
  actions.innerHTML = actionsHtml;
  const attachBtn = document.getElementById("btnAttachInvoice");
  if (attachBtn) attachBtn.addEventListener("click", () => openAttachInvoice(r.id));
  const dlBtn = document.getElementById("btnDownload");
  if (dlBtn) dlBtn.addEventListener("click", () => downloadRecordFile(r));

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
  const records = mineDisplay.length ? mineDisplay : mergedRecords(); // 匯出目前篩選後的清單
  if (records.length === 0) { showToast("目前沒有資料可匯出"); return; }
  // 欄位順序對齊 google-sync/Code.gs 的 HEADERS（31 欄），貼上收支表時才會對到同一欄
  const headers = ["上傳時間", "上傳者", "所屬專案", "單據類型", "發票日期", "本次金額", "報價總額", "用途", "公司名稱", "付款狀態", "付款方式", "信用卡形式", "還款對象", "收款對象", "付款資訊", "確認事項", "關聯報價單", "急迫性", "期望撥款日期", "狀態", "審核人", "審核時間", "退回原因", "單據完備", "付款日期", "會計科目", "預算項目", "所屬期間", "憑證檔名", "憑證雲端連結", "紀錄ID"];
  const rows = records.map(r => [
    fmtDateTimeForSheet(r.uploadedAt), r.uploader, r.project, r.docType || "發票 / 收據", r.invoiceDate,
    r.amount, r.quoteTotal || "", r.purpose, r.vendor,
    r.payStatus || "", r.payMethod || "", r.cardForm || "", r.repayTarget || "", r.payee || "", r.paymentDetail || "", r.confirmNote || "", r.linkedQuoteId || "",
    r.urgent ? "緊急" : "一般", r.expectedPayoutDate || "", statusLabel(recStatusKey(r)),
    r.reviewer, fmtDateTimeForSheet(r.reviewedAt), r.rejectReason,
    r.receiptComplete ? "是" : "否", r.paidAt || "", r.glCode || "",
    r.budgetItem || "", r.period, r.fileName, r.fileUrl || "", r.id,
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
/* v2 起改用「用 Google 帳號登入」驗證身分，取代舊的網址＋密碼＋一次性連結。
   部署網址直接寫死在這裡（它不是機密）；每次請求都帶上 Google 發的登入證明(ID token)，
   後端 Code.gs 驗證它是不是組織帳號（@skillsforu.org）才准寫資料。 */
const DEPLOY_URL = "https://script.google.com/macros/s/AKfycbyliWKUmaMXLkAVyHPXhdF2lQVZGJOreZyWz-Us2ktCwl_ZsmFaTy1lDq21gGQyUaOy/exec";
const GOOGLE_CLIENT_ID = "367734743259-m1si6lu02113c1e53v80t4gnf40poop0.apps.googleusercontent.com";

let idToken = null;      // 這次登入的 Google 身分證明；每次請求都會帶上（約 1 小時後過期）
let currentUser = null;  // { email, name, unknownPerson }，登入後由後端 getConfig 回傳

function isSignedIn() { return !!idToken; }

// 舊程式碼很多地方讀 loadSyncConfig()（判斷是否已連雲端、要不要抓名單等）。保留這個名字當「相容層」：
// 登入成功後就等於雲端已啟用、網址固定、雲端 OCR 一律開。
function loadSyncConfig() {
  return { enabled: isSignedIn(), url: DEPLOY_URL, token: "", cloudOcrEnabled: true };
}

// 所有打到 Apps Script 的請求都走這裡：自動帶上登入證明，後端回報「登入逾期」時引導重新登入。
async function cloudPost(action, extra) {
  const res = await fetch(DEPLOY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // 避免 CORS 預檢；Apps Script 端用 JSON.parse 解析
    body: JSON.stringify(Object.assign({ idToken: idToken || "", action: action }, extra || {})),
  });
  const data = await res.json();
  if (data && data.authError) onAuthExpired();
  return data;
}

/* ---- 登入畫面與流程 ----
   Google 發的「登入證明」(ID token) 本身大約 1 小時就會過期，這是 Google 寫死的安全限制，
   沒辦法直接調成一週那麼長。但只要瀏覽器裡 Google 帳號本身還在登入狀態（這個通常放很久，
   跟 Gmail 一樣），就可以在背景安靜地換發新的證明，使用者完全不會看到、也不用重新點登入
   ——這裡做的就是這件事：定時背景換發 + 開頁面時盡量安靜地自動登入，把「感覺上要一直重新
   登入」的問題降到最低，而不是假裝能讓同一張證明本身撐更久（那個做不到）。 */
const TOKEN_SILENT_REFRESH_MS = 45 * 60 * 1000; // 45 分鐘背景換發一次，搶在 ~1 小時到期之前
let tokenRefreshTimer = null;

function initGoogleAuth() {
  if (!(window.google && google.accounts && google.accounts.id)) return;
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: onGoogleCredential,
    auto_select: true,
    use_fedcm_for_prompt: true, // Google 目前建議的做法，第三方 cookie 陸續被瀏覽器擋掉後，沒開這個容易出現「點了帳號卻沒反應」
  });
  const btnWrap = document.getElementById("googleSignInBtn");
  if (btnWrap) {
    btnWrap.innerHTML = "";
    google.accounts.id.renderButton(btnWrap, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill", width: 260 });
  }
  // 有登入過的話盡量安靜地直接帶入，不用使用者自己點；先給個提示字樣，
  // 免得使用者在這一兩秒空窗期以為畫面卡住了。保險起見最多等 4 秒就把提示收掉，
  // 避免瀏覽器判斷「這次不顯示」時 callback 沒被呼叫、提示留在畫面上一直不消失。
  showLoginStatus("正在確認登入狀態…");
  const hideSoon = setTimeout(hideLoginStatus, 4000);
  google.accounts.id.prompt(() => { clearTimeout(hideSoon); hideLoginStatus(); });
}
// GIS 是 async 載入的，載好會呼叫這個全域函式；萬一它比 app.js 早載好，下面初始化時也會再試一次。
window.onGoogleLibraryLoad = initGoogleAuth;

function onGoogleCredential(resp) {
  idToken = resp && resp.credential;
  if (idToken) { showLoginStatus("登入中…"); onSignedIn(); }
}

async function onSignedIn() {
  let data;
  try {
    data = await cloudPost("getConfig"); // 同時驗證身分、抓名單、拿到「我是誰」
  } catch (e) {
    showLoginError("連線失敗，請稍後再試：" + e.message);
    return;
  }
  if (!data || !data.ok) {
    showLoginError((data && data.error) || "登入失敗，請重試。");
    idToken = null;
    return;
  }
  hideLoginStatus();
  applyCloudConfig(data);
  const gate = document.getElementById("loginGate");
  if (gate) gate.hidden = true;
  const chip = document.getElementById("accountChip");
  if (chip) chip.hidden = false;
  scheduleTokenRefresh();
}

// 中性狀態（登入中…／正在確認…），跟下面的錯誤訊息共用同一個元素但顏色不同，避免看起來像出錯了
function showLoginStatus(msg) {
  const hint = document.getElementById("loginHint");
  if (hint) { hint.textContent = msg; hint.className = "login-hint login-hint-info"; hint.hidden = false; }
}
function hideLoginStatus() {
  const hint = document.getElementById("loginHint");
  // 只收「中性狀態」那一種，真正的錯誤訊息（沒有 login-hint-info 這個 class）要留著讓人看到
  if (hint && hint.classList.contains("login-hint-info")) hint.hidden = true;
}
function showLoginError(msg) {
  const hint = document.getElementById("loginHint");
  if (hint) { hint.textContent = msg; hint.className = "login-hint"; hint.hidden = false; }
}

// 背景定時安靜換發新的登入證明，使用者不會看到任何畫面變化；換發失敗也不主動打擾，
// 反正真的過期時，下一次打 API 會收到 authError、onAuthExpired 自然會跳回登入畫面。
function scheduleTokenRefresh() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = setInterval(() => {
    if (!isSignedIn()) return;
    try { google.accounts.id.prompt(); } catch (e) { /* 安靜失敗，等真的過期再處理 */ }
  }, TOKEN_SILENT_REFRESH_MS);
}
function stopTokenRefresh() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = null;
}

function onAuthExpired() {
  idToken = null;
  stopTokenRefresh();
  const gate = document.getElementById("loginGate");
  if (gate) gate.hidden = false;
  const chip = document.getElementById("accountChip");
  if (chip) chip.hidden = true;
  showLoginError("登入已逾期，請重新登入。");
  initGoogleAuth();
}

function signOut() {
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  idToken = null;
  currentUser = null;
  stopTokenRefresh();
  const chip = document.getElementById("accountChip");
  if (chip) chip.hidden = true;
  const gate = document.getElementById("loginGate");
  if (gate) gate.hidden = false;
  initGoogleAuth();
}

// 把 getConfig 回來的名單存進本機快取、更新下拉，並記住登入者、把「上傳人」自動帶成本人
function applyCloudConfig(data) {
  if (Array.isArray(data.uploaders)) saveUploaders(data.uploaders);
  if (Array.isArray(data.projects)) saveProjects(data.projects);
  if (Array.isArray(data.centers)) saveCenters(data.centers);
  if (data.projectsByCenter && typeof data.projectsByCenter === "object") saveProjectsByCenter(data.projectsByCenter);
  if (data.budgetItemsByProject && typeof data.budgetItemsByProject === "object") saveBudgetItemsByProject(data.budgetItemsByProject);
  populateUploaderAndProjectSelects();
  populateBudgetItemOptions(projectSelect.value);
  currentUser = data.me || null;
  const nameEl = document.getElementById("accountName");
  if (nameEl && currentUser) nameEl.textContent = currentUser.name + (currentUser.unknownPerson ? "（不在名單）" : "");
  applyCurrentUserAsUploader();
}

// 上傳人＝登入者本人（後端也會強制覆蓋，這裡只是讓畫面顯示一致、不再讓人手選）
function applyCurrentUserAsUploader() {
  if (!currentUser || !currentUser.name) return;
  const sel = uploaderSelect;
  if (![...sel.options].some(o => o.value === currentUser.name)) {
    const opt = document.createElement("option");
    opt.value = currentUser.name; opt.textContent = currentUser.name;
    sel.appendChild(opt);
  }
  sel.value = currentUser.name;
  sel.disabled = true;
}

// 同步狀態只能由「雲端 → 本機」單向流動（審核在 Google 試算表發生，網頁只能拉取結果）。
// 「重新同步」按鈕只在真的還沒同步成功時才顯示——一旦 cloudSynced 是 true，代表這筆紀錄
// 早就送到雲端了，之後任何變動（審核、付款、單據完備）都應該用「🔄 重新整理審核狀態」去拉，
// 絕對不能再讓使用者手動觸發把本機可能已經過期的舊資料推回去，蓋掉主管剛審核完的結果。
function cloudStatusHtml(r) {
  const config = loadSyncConfig();
  if (!config.enabled || !config.url) return "";
  const statusText = r.cloudSynced ? "已同步至 Google 試算表" : (r.cloudError ? "同步失敗：" + escapeHtml(r.cloudError) : "尚未同步");
  const linkHtml = r.cloudFileUrl ? ` ・ <a href="${escapeHtml(r.cloudFileUrl)}" target="_blank" rel="noopener">查看雲端檔案</a>` : "";
  const retryBtnHtml = r.cloudSynced ? "" : `
    <div class="btn-row">
      <button class="ghost-btn" id="btnRetrySync" style="flex:1;">同步至雲端</button>
    </div>`;
  return `
    <div class="confidence-banner ${r.cloudSynced ? "high" : "low"}">
      ☁ ${statusText}${linkHtml}
    </div>
    ${retryBtnHtml}
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
  if (!isSignedIn()) return { ok: false, skipped: true };
  try {
    const data = await cloudPost(action, { record });
    if (data && data.ok) {
      // 同步成功代表 Drive 上已經有正本了，本機縮圖只是上傳前的暫存，主動清掉可以避免
      // localStorage 累積到爆滿（憑證照片的 base64 很佔空間，瀏覽器通常只有 5~10MB 可用）。
      // 「查看雲端檔案」連結（cloudFileUrl）會接手負責預覽/下載。
      updateRecordCloudStatus(record.id, { cloudSynced: true, cloudFileUrl: data.fileUrl || record.cloudFileUrl || "", cloudError: "", fileDataUrl: "" });
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
  if (!isSignedIn()) {
    showToast("尚未登入，無法重新整理狀態");
    return;
  }
  try {
    const data = await cloudPost("getStatuses");
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

const CLOUD_OCR_TIMEOUT_MS = 120000; // 逾時就直接判定失敗、退回本機離線辨識，避免無上限空等
// PDF 常常比單張照片慢很多（Gemini 要先解析頁面），實測有正常成功但花了 1 分 46 秒的案例，
// 45 秒太短、會誤把「還在跑、最後會成功」的辨識判定成失敗，所以拉長到 2 分鐘。

// data 可以是單一張圖片/PDF 的 dataURL 字串，也可以是多張圖片 dataURL 組成的陣列（PDF 轉圖片後的多頁）
async function cloudOcrRecognize(data) {
  if (!isSignedIn()) return { ok: false, error: "尚未登入" };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLOUD_OCR_TIMEOUT_MS);
  try {
    const payload = { idToken: idToken || "", action: "ocr" };
    if (Array.isArray(data)) payload.imageDataUrls = data; else payload.imageDataUrl = data;
    const res = await fetch(DEPLOY_URL, {
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
const signOutBtn = document.getElementById("signOutBtn");
if (signOutBtn) signOutBtn.addEventListener("click", signOut);

populateUploaderAndProjectSelects(); // 先用本機快取把畫面鋪好（登入畫面會蓋在最上面）
populateBudgetItemOptions(projectSelect.value);
switchView("upload");
// 顯示登入畫面、等使用者用組織帳號登入；登入成功後才會抓名單、把畫面打開（見 onSignedIn）
initGoogleAuth();
