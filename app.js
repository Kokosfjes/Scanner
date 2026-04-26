import { firebaseConfig } from "./firebase-config.js";

const resultEl = document.getElementById("result");
const overlayEl = document.getElementById("scan-overlay");
const viewHub = document.getElementById("view-hub");
const viewScan = document.getElementById("view-scan");
const btnScan = document.getElementById("btn-scan");
const btnBack = document.getElementById("btn-back");
const statOk = document.getElementById("stat-ok");
const statBad = document.getElementById("stat-bad");

const configPlaceholder = firebaseConfig.apiKey === "YOUR_API_KEY";
if (configPlaceholder) {
  alert("Firebase ikke konfigurert — rediger firebase-config.js");
  throw new Error("Firebase config missing");
}

const [appMod, fsMod] = await Promise.all([
  import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js"),
  import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"),
]);
const fs = fsMod;
const app = appMod.initializeApp(firebaseConfig);
const db = fs.getFirestore(app);

const counts = { ok: 0, bad: 0 };
let lastScanTime = 0;
const SCAN_COOLDOWN_MS = 3000;
const AUTO_RETURN_MS = 1500;
let autoReturnTimer = null;

const VERDICT = {
  OK: "ok",
  DUPLICATE: "duplicate",
  UNKNOWN: "unknown",
  ERROR: "error",
};

const formats = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.PDF_417,
  Html5QrcodeSupportedFormats.AZTEC,
];

const scanConfig = {
  fps: 25,
  qrbox: (w, h) => {
    const side = Math.floor(Math.min(w, h) * 0.75);
    return { width: side, height: Math.floor(side * 0.55) };
  },
  disableFlip: false,
  experimentalFeatures: {
    useBarCodeDetectorIfSupported: true,
  },
};

const cameraConstraints = {
  facingMode: "environment",
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  focusMode: "continuous",
  advanced: [
    { focusMode: "continuous" },
    { zoom: 1.5 },
  ],
};

const scanner = new Html5Qrcode("reader", { formatsToSupport: formats, verbose: false });
let isRunning = false;

const formManual = document.getElementById("form-manual");
const manualInput = document.getElementById("manual-input");

btnScan.addEventListener("click", openScanView);
btnBack.addEventListener("click", closeScanView);
formManual.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = manualInput.value.trim();
  if (!value) return;
  manualInput.blur();
  await processCode(value, { fromScan: false });
  manualInput.value = "";
});

async function openScanView() {
  viewHub.classList.remove("active");
  viewScan.classList.add("active");
  hideOverlay();
  lastScanTime = 0;
  await startScanner();
}

async function closeScanView() {
  if (autoReturnTimer) {
    clearTimeout(autoReturnTimer);
    autoReturnTimer = null;
  }
  await stopScanner();
  viewScan.classList.remove("active");
  viewHub.classList.add("active");
  hideOverlay();
}

async function startScanner() {
  if (isRunning) return;
  try {
    await scanner.start(cameraConstraints, scanConfig, onScanSuccess, () => {});
    isRunning = true;
  } catch (err1) {
    console.warn("detailed constraints failed, trying basic environment", err1);
    try {
      await scanner.start({ facingMode: "environment" }, scanConfig, onScanSuccess, () => {});
      isRunning = true;
    } catch (err2) {
      console.warn("facingMode failed, trying camera list fallback", err2);
      try {
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras.length) throw new Error("Ingen kameraer funnet");
        const back = cameras.find((c) => /back|rear|environment/i.test(c.label)) ?? cameras[cameras.length - 1];
        await scanner.start(back.id, scanConfig, onScanSuccess, () => {});
        isRunning = true;
      } catch (err3) {
        console.error("Camera start failed", err3);
        alert("Kamera kunne ikke åpnes: " + (err3?.message ?? err3));
        closeScanView();
      }
    }
  }
}

async function stopScanner() {
  if (!isRunning) return;
  try {
    await scanner.stop();
    await scanner.clear();
  } catch (err) {
    console.warn("stop failed", err);
  }
  isRunning = false;
}

async function onScanSuccess(decodedText) {
  await processCode(decodedText, { fromScan: true });
}

async function processCode(value, { fromScan = false } = {}) {
  if (fromScan) {
    const now = Date.now();
    if (now - lastScanTime < SCAN_COOLDOWN_MS) return;
    lastScanTime = now;
  }

  let verdict;
  let name = null;

  try {
    const result = await claimCode(value);
    verdict = result.verdict;
    name = result.name;
  } catch (err) {
    console.error(err);
    verdict = VERDICT.ERROR;
  }

  if (verdict === VERDICT.OK) counts.ok++;
  else counts.bad++;
  statOk.textContent = counts.ok;
  statBad.textContent = counts.bad;

  updateHubResult(verdict, value, name);

  if (fromScan) {
    showOverlay(verdict, name);
    flashScanView(verdict);
  }

  if (navigator.vibrate) {
    navigator.vibrate(verdict === VERDICT.OK ? 80 : [60, 60, 60]);
  }

  if (fromScan) {
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      closeScanView();
    }, AUTO_RETURN_MS);
  }
}

async function claimCode(value) {
  const regRef = fs.doc(db, "registered", value);
  return await fs.runTransaction(db, async (tx) => {
    const snap = await tx.get(regRef);
    if (!snap.exists()) {
      return { verdict: VERDICT.UNKNOWN, name: null };
    }
    const data = snap.data();
    const name = data.name ?? "(uten navn)";
    if (data.used === true) {
      return { verdict: VERDICT.DUPLICATE, name };
    }
    tx.update(regRef, {
      used: true,
      usedAt: fs.serverTimestamp(),
    });
    return { verdict: VERDICT.OK, name };
  });
}

function verdictLabel(verdict) {
  if (verdict === VERDICT.OK) return "✓ GODKJENT";
  if (verdict === VERDICT.DUPLICATE) return "✗ ALLEREDE BRUKT";
  if (verdict === VERDICT.UNKNOWN) return "✗ IKKE REGISTRERT";
  return "✗ FEIL";
}

function verdictSubLabel(verdict) {
  if (verdict === VERDICT.DUPLICATE) return "Koden er allerede skannet";
  if (verdict === VERDICT.UNKNOWN) return "Koden finnes ikke i databasen";
  if (verdict === VERDICT.ERROR) return "Noe gikk galt";
  return null;
}

function updateHubResult(verdict, value, name) {
  const isOk = verdict === VERDICT.OK;
  document.body.classList.remove("result-ok", "result-bad");
  document.body.classList.add(isOk ? "result-ok" : "result-bad");

  resultEl.classList.remove("empty");
  resultEl.classList.toggle("ok", isOk);
  resultEl.classList.toggle("bad", !isOk);
  resultEl.innerHTML = "";

  const verdictEl = document.createElement("div");
  verdictEl.className = "verdict";
  verdictEl.textContent = verdictLabel(verdict);
  resultEl.appendChild(verdictEl);

  if (name) {
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = name;
    resultEl.appendChild(nameEl);
  }

  const sub = verdictSubLabel(verdict);
  if (sub) {
    const subEl = document.createElement("div");
    subEl.className = "meta";
    subEl.textContent = sub;
    resultEl.appendChild(subEl);
  }

  const val = document.createElement("div");
  val.className = "value";
  val.textContent = value;
  resultEl.appendChild(val);

  const time = document.createElement("div");
  time.className = "meta";
  time.textContent = new Date().toLocaleTimeString();
  resultEl.appendChild(time);
}

function showOverlay(verdict, name) {
  const isOk = verdict === VERDICT.OK;
  overlayEl.classList.remove("ok", "bad");
  overlayEl.classList.add(isOk ? "ok" : "bad", "show");
  overlayEl.innerHTML = "";

  const v = document.createElement("div");
  v.className = "verdict";
  v.textContent = verdictLabel(verdict);
  overlayEl.appendChild(v);

  if (name) {
    const n = document.createElement("div");
    n.className = "name";
    n.textContent = name;
    overlayEl.appendChild(n);
  }

  const sub = verdictSubLabel(verdict);
  if (sub) {
    const s = document.createElement("div");
    s.className = "sub";
    s.textContent = sub;
    overlayEl.appendChild(s);
  }
}

function hideOverlay() {
  overlayEl.classList.remove("show", "ok", "bad");
  viewScan.classList.remove("flash-ok", "flash-bad");
}

function flashScanView(verdict) {
  const isOk = verdict === VERDICT.OK;
  viewScan.classList.remove("flash-ok", "flash-bad");
  void viewScan.offsetWidth;
  viewScan.classList.add(isOk ? "flash-ok" : "flash-bad");
}

// ---------- Lister ----------

const btnShowUsed = document.getElementById("btn-show-used");
const btnShowUnused = document.getElementById("btn-show-unused");
const countUsedEl = document.getElementById("count-used");
const countUnusedEl = document.getElementById("count-unused");
const listModal = document.getElementById("list-modal");
const listModalTitle = document.getElementById("list-modal-title");
const listSearch = document.getElementById("list-search");
const listSummary = document.getElementById("list-summary");
const listItems = document.getElementById("list-items");

let listUnsub = null;
let listRows = [];
let listMode = null;

subscribeCounts();

btnShowUsed.addEventListener("click", () => openListModal("used"));
btnShowUnused.addEventListener("click", () => openListModal("unused"));
listModal.addEventListener("click", (e) => {
  if (e.target === listModal || e.target.dataset.close !== undefined) closeListModal();
});
listSearch.addEventListener("input", renderList);

function subscribeCounts() {
  fs.onSnapshot(
    fs.collection(db, "registered"),
    (snap) => {
      let used = 0, unused = 0;
      snap.forEach((d) => { d.data().used === true ? used++ : unused++; });
      countUsedEl.textContent = used;
      countUnusedEl.textContent = unused;
    },
    (err) => {
      console.error("count subscribe failed", err);
      countUsedEl.textContent = "?";
      countUnusedEl.textContent = "?";
    }
  );
}

function openListModal(mode) {
  listMode = mode;
  listRows = [];
  listSearch.value = "";
  listModalTitle.textContent = mode === "used" ? "Sjekket inn" : "Ikke sjekket inn";
  listSummary.textContent = "Laster…";
  listItems.innerHTML = "";
  listModal.classList.add("open");
  subscribeList(mode);
}

function closeListModal() {
  listModal.classList.remove("open");
  if (listUnsub) { listUnsub(); listUnsub = null; }
}

function subscribeList(mode) {
  if (listUnsub) listUnsub();
  const q = fs.query(
    fs.collection(db, "registered"),
    fs.where("used", "==", mode === "used")
  );
  listUnsub = fs.onSnapshot(
    q,
    (snap) => {
      listRows = [];
      snap.forEach((d) => {
        const data = d.data();
        listRows.push({
          code: d.id,
          name: data.name ?? "(uten navn)",
          usedAt: data.usedAt?.toDate?.() ?? null,
        });
      });
      if (mode === "used") {
        listRows.sort((a, b) => (b.usedAt?.getTime() ?? 0) - (a.usedAt?.getTime() ?? 0));
      } else {
        listRows.sort((a, b) => a.name.localeCompare(b.name, "nb"));
      }
      renderList();
    },
    (err) => {
      console.error("list subscribe failed", err);
      listSummary.textContent = "Feil: " + err.message;
    }
  );
}

function renderList() {
  const filter = listSearch.value.trim().toLowerCase();
  const rows = filter
    ? listRows.filter((r) => r.name.toLowerCase().includes(filter) || r.code.includes(filter))
    : listRows;
  listSummary.textContent = `${rows.length}${filter ? ` av ${listRows.length}` : ""}`;
  listItems.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = r.name;
    const nrEl = document.createElement("div");
    nrEl.className = "nr";
    const timeStr = listMode === "used" && r.usedAt ? ` · ${r.usedAt.toLocaleTimeString()}` : "";
    nrEl.textContent = r.code + timeStr;
    li.appendChild(nameEl);
    li.appendChild(nrEl);
    listItems.appendChild(li);
  }
}
