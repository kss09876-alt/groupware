// app.js — 로그인/폴더연결 흐름 + 탭 전환 + 각 모듈의 이벤트 처리

let dataFolderId = localStorage.getItem("gw_folderId") || null;
let currentTab = "dashboard";
let corpSubTab = "info"; // 법인정보 탭 내부 하위탭: "info" | "seal"
const cache = {}; // 모듈별 로드된 데이터 캐시 (탭 전환 시 재사용, 저장 후 무효화)

// AI 콘텐츠 생성 모달의 임시 상태 (모달 열려있는 동안만 메모리에 보관)
let aiGalleryImages = []; // 생성된 이미지 dataURL 목록
let aiSelectedImageDataUrl = null; // 대표로 고른 이미지
let aiVideoBlob = null; // 생성된 슬라이드쇼 동영상
// "콘텐츠 등록" 폼으로 넘어갈 때까지 잠깐 들고 있는 첨부 미디어 (저장 시 드라이브에 업로드됨)
let pendingAiImageDataUrl = null;
let pendingAiVideoBlob = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function showScreen(id) {
  ["loginScreen", "folderScreen", "app"].forEach((s) => {
    $("#" + s).style.display = s === id ? (id === "app" ? "flex" : "flex") : "none";
  });
}

function setSyncStatus(text, busy) {
  const el = $("#syncStatus");
  el.textContent = text;
  el.classList.toggle("busy", !!busy);
}

// ---------------- 부트스트랩 ----------------
// "로그인 유지": 구글 액세스 토큰(보통 1시간 유효)을 localStorage에 캐시해뒀다가,
// 새로고침 시 아직 유효하면 팝업 없이 그대로 재사용해요. (참고: 브라우저는 사용자의
// 실제 클릭 없이 뜨는 로그인 팝업을 차단하기 때문에, "페이지 로드 시 자동으로 팝업 로그인"
// 방식은 동작하지 않아요 — 그래서 토큰 캐시 방식으로 구현했어요.) 캐시된 토큰이 만료되면
// (보통 1시간 뒤) "Google 계정으로 로그인" 버튼을 한 번 눌러주셔야 해요.
window.addEventListener("load", async () => {
  if (!CONFIG.CLIENT_ID.includes(".apps.googleusercontent.com") || CONFIG.CLIENT_ID.startsWith("YOUR_")) {
    $("#setupWarning").style.display = "block";
  }

  $("#loginStatus").textContent = "로그인 확인 중...";

  await Drive.loadGapiClient();
  await waitForGoogleIdentity();

  Drive.initTokenClient(async (user, err) => {
    if (err || !user) {
      $("#loginStatus").textContent = "로그인에 실패했어요. 다시 시도해주세요.";
      return;
    }
    onSignedIn(user);
  });

  google.accounts.id.renderButton(
    $("#googleSignInBtn") /* fallback element, real sign-in uses token client */,
    { theme: "outline", size: "large" }
  );
  // 실제 로그인은 버튼 클릭 시 token client로 처리 (Drive scope 획득을 위해)
  const btn = document.createElement("button");
  btn.className = "btn btn-primary btn-google";
  btn.textContent = "Google 계정으로 로그인";
  btn.onclick = () => {
    $("#loginStatus").textContent = "로그인 창을 여는 중...";
    // 이미 이전에 동의한 사용자면 화면 깜빡임 없이 바로 토큰만 다시 받아와요.
    // (한 번도 동의한 적 없는 새 사용자는 자동으로 동의 화면이 함께 떠요.)
    Drive.requestSignIn();
  };
  $("#googleSignInBtn").innerHTML = "";
  $("#googleSignInBtn").appendChild(btn);

  // 캐시된 토큰이 아직 유효하면 팝업 없이 바로 로그인 상태로 복원
  const restoredUser = await Drive.restoreSession();
  if (restoredUser) {
    onSignedIn(restoredUser);
  } else {
    $("#loginStatus").textContent = "";
  }
});

function waitForGoogleIdentity() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.google && google.accounts && google.accounts.oauth2) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

async function onSignedIn(user) {
  $("#userName").textContent = user.name;
  $("#userEmail").textContent = user.email;
  $("#userAvatar").src = user.picture || "";

  if (dataFolderId) {
    showScreen("app");
    await goTab("dashboard");
    runSnsAutoPublish();
    return;
  }

  // 이 브라우저/기기에 저장된 폴더 ID가 없어도, 구글 드라이브(=서버) 자체에는
  // 이미 데이터 폴더가 있을 수 있어요. 화면을 보여주기 전에 먼저 조용히 찾아보고,
  // 있으면 그걸 그대로 연결해서 "새 폴더 만들기"를 다시 누르지 않아도 되게 해요.
  showScreen("folderScreen");
  $("#folderStatus").textContent = "데이터 폴더 확인 중...";
  try {
    const existing = await Drive.findDataFolder();
    if (existing) {
      dataFolderId = existing.id;
      localStorage.setItem("gw_folderId", dataFolderId);
      showScreen("app");
      await goTab("dashboard");
      runSnsAutoPublish();
      return;
    }
  } catch (e) {
    console.error(e);
  }
  $("#folderStatus").textContent = "";
}

$("#createFolderBtn")?.addEventListener("click", async () => {
  $("#folderStatus").textContent = "폴더를 만드는 중...";
  // createDataFolder는 이미 같은 이름의 폴더가 있으면 새로 만들지 않고 그 폴더를 재사용해요.
  const folder = await Drive.createDataFolder();
  dataFolderId = folder.id;
  localStorage.setItem("gw_folderId", dataFolderId);
  showScreen("app");
  await goTab("dashboard");
});

$("#pickFolderBtn")?.addEventListener("click", async () => {
  const folder = await Drive.openFolderPicker();
  if (!folder) return;
  dataFolderId = folder.id;
  localStorage.setItem("gw_folderId", dataFolderId);
  showScreen("app");
  await goTab("dashboard");
});

$("#signOutBtn")?.addEventListener("click", () => {
  Drive.signOut();
  localStorage.removeItem("gw_folderId");
  dataFolderId = null;
  location.reload();
});

// ---------------- 데이터 로드/저장 ----------------
async function loadModule(name, force) {
  if (cache[name] && !force) return cache[name];
  setSyncStatus("동기화 중...", true);
  try {
    let data = await Drive.readCollection(dataFolderId, FILES[name], DEFAULTS[name]);
    if (name === "corp") data = normalizeCorp(data);
    cache[name] = data;
    setSyncStatus("동기화됨", false);
    return data;
  } catch (e) {
    setSyncStatus("동기화 실패", false);
    console.error(e);
    return DEFAULTS[name];
  }
}

async function saveModule(name, data) {
  setSyncStatus("저장 중...", true);
  cache[name] = data;
  await Drive.writeCollection(dataFolderId, FILES[name], data);
  setSyncStatus("동기화됨", false);
}

const ctx = {
  get user() {
    return Drive.user;
  },
  get corpSubTab() {
    return corpSubTab;
  },
  load: loadModule,
};

// ---------------- 탭 전환 ----------------
const TAB_TITLES = {
  dashboard: "대시보드",
  corp: "법인정보",
  notice: "공지사항",
  calendar: "일정/캘린더",
  approval: "전자결재",
  attendance: "근태관리",
  sns: "SNS 운영",
};

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    goTab(btn.dataset.tab);
    closeMobileSidebar();
  });
});

async function goTab(tab) {
  currentTab = tab;
  if (tab === "corp") corpSubTab = "info";
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#pageTitle").textContent = TAB_TITLES[tab];
  $("#content").innerHTML = `<div class="loading">불러오는 중...</div>`;
  const html = await Modules[tab](ctx);
  $("#content").innerHTML = html;
  bindTabEvents(tab);
}

// ---------------- 모바일 사이드바 열기/닫기 ----------------
// 화면이 좁을 땐 사이드바를 화면 밖으로 숨겨뒀다가(css) 햄버거 버튼을 누르면
// 슬라이드로 열어주는 방식이에요. 데스크탑에서는 이 클래스들이 css에서 무시돼요.
function openMobileSidebar() {
  $("#sidebar")?.classList.add("open");
  $("#sidebarOverlay")?.classList.add("open");
}
function closeMobileSidebar() {
  $("#sidebar")?.classList.remove("open");
  $("#sidebarOverlay")?.classList.remove("open");
}
$("#mobileMenuBtn")?.addEventListener("click", openMobileSidebar);
$("#sidebarCloseBtn")?.addEventListener("click", closeMobileSidebar);
$("#sidebarOverlay")?.addEventListener("click", closeMobileSidebar);

async function refreshCurrentTab() {
  const html = await Modules[currentTab](ctx);
  $("#content").innerHTML = html;
  bindTabEvents(currentTab);
}

// ---------------- 모달 ----------------
function openModal(html) {
  $("#modalBox").innerHTML = html;
  $("#modalBackdrop").style.display = "flex";
  $$("[data-close]", $("#modalBox")).forEach((b) => b.addEventListener("click", closeModal));
}
function closeModal() {
  $("#modalBackdrop").style.display = "none";
  $("#modalBox").innerHTML = "";
}
$("#modalBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "modalBackdrop") closeModal();
});

// ---------------- AI 서류 자동 분석 (법인정보) ----------------
// 드라이브에 올라간 서류 파일을 내려받아 Cloudflare Worker(→ Gemini API)로 보내고,
// 문서 종류(docKey)에 맞는 구조화된 정보를 돌려받습니다. 실제 corp.json 저장은
// 사용자가 확인창(Modules.aiReviewForm)에서 "적용하기"를 눌러야만 이뤄집니다.
async function aiExtractDocument(docKey, fileId) {
  const { base64, mimeType } = await Drive.downloadFileAsBase64(fileId);
  const res = await fetch(CONFIG.AI_WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docKey, mimeType, dataBase64: base64 }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) {
    throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
  }
  return data.fields || {};
}

// AI가 추출한 필드를 corp 객체에 병합합니다. 단순 텍스트 필드는 값이 있을 때만 덮어쓰고,
// 목록형 필드(주주/임원/지점/목적)는 AI가 읽어낸 내용이 있으면 통째로 교체합니다.
// (사용자가 이미 확인창에서 내용을 보고 "적용"을 눌렀다는 전제이며, 교체 후에도
//  법인정보 화면의 +추가/삭제 버튼으로 언제든 다시 수정할 수 있습니다.)
function applyAiFields(c, fields) {
  const simpleKeys = [
    "name", "engName", "regNo", "bizNo", "foundedDate", "capital",
    "capitalShares", "parValue", "address", "disclosureMethod",
    "stockOptionRule", "transferRestrictionRule",
  ];
  simpleKeys.forEach((k) => {
    const v = fields[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") c[k] = v;
  });
  if (Array.isArray(fields.branches) && fields.branches.length) c.branches = fields.branches;
  if (Array.isArray(fields.registeredPurposes) && fields.registeredPurposes.length) c.registeredPurposes = fields.registeredPurposes;
  if (Array.isArray(fields.officers) && fields.officers.length) c.officers = fields.officers;
  if (Array.isArray(fields.shareholders) && fields.shareholders.length) c.shareholders = fields.shareholders;
  if (fields.articleFlags && typeof fields.articleFlags === "object") {
    c.articleFlags = { ...c.articleFlags, ...fields.articleFlags };
  }
  if (fields.meetings && typeof fields.meetings === "object") {
    c.meetings = { ...c.meetings, ...fields.meetings };
  }
  return c;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------- 인감관리: 서류에 도장 이미지 찍기 (pdf-lib + pdf.js 사용) ----------------
// 실제 등기소/공증 효력이 있는 전자서명이 아니라, 사내 서류에 도장 이미지를
// 시각적으로 얹어주는 기능입니다. jpg/png는 먼저 1페이지짜리 PDF로 감싼 뒤 처리합니다.
// pdf-lib(PDF 생성/편집)와 pdf.js(미리보기 렌더링)는 꽤 무거운 라이브러리라, 처음부터
// 불러오지 않고 인감관리에서 실제로 서류를 올릴 때만 불러와서(lazy load) 초기 로딩 속도를 지킵니다.
const PDF_LIB_SRC = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const PDFJS_WORKER_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const scriptLoadCache = {};
function loadScriptOnce(src) {
  if (scriptLoadCache[src]) return scriptLoadCache[src];
  scriptLoadCache[src] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("스크립트를 불러오지 못했어요: " + src));
    document.head.appendChild(s);
  });
  return scriptLoadCache[src];
}
async function ensurePdfLibs() {
  await Promise.all([loadScriptOnce(PDF_LIB_SRC), loadScriptOnce(PDFJS_SRC)]);
  if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }
}

async function toPdfBytes(file) {
  const { PDFDocument } = PDFLib;
  const arrayBuf = await file.arrayBuffer();
  if (file.type.startsWith("image/")) {
    const doc = await PDFDocument.create();
    const img = file.type.includes("png") ? await doc.embedPng(arrayBuf) : await doc.embedJpg(arrayBuf);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return await doc.save();
  }
  return new Uint8Array(arrayBuf);
}

// 서류 미리보기를 캔버스에 그리고, 사용자가 클릭한 위치를 기억해뒀다가
// "날인하기"를 누르면 그 좌표에 정확히 도장을 찍습니다.
let sealPlaceState = null;
async function setupSealPlacer(pdfBytes, fileName, seals) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const pageCount = pdf.numPages;

  const pageSelect = $("#f_sealPageNum");
  pageSelect.innerHTML = Array.from(
    { length: pageCount },
    (_, i) => `<option value="${i + 1}">${i + 1} 페이지${i === pageCount - 1 ? " (마지막)" : ""}</option>`
  ).join("");
  pageSelect.value = String(pageCount);

  sealPlaceState = { pdfBytes, fileName, pageIndex: pageCount - 1, x: null, y: null, viewport: null, sealType: null, sealDataUrl: null };

  const updateMarkerSrc = () => {
    const sealType = $("#f_sealType").value;
    const seal = seals[sealType];
    sealPlaceState.sealType = sealType;
    sealPlaceState.sealDataUrl = seal && seal.imageDataUrl;
    if (sealPlaceState.sealDataUrl) $("#sealPlaceMarker").src = sealPlaceState.sealDataUrl;
  };
  updateMarkerSrc();
  $("#f_sealType").addEventListener("change", updateMarkerSrc);

  async function renderPage(pageNum) {
    const page = await pdf.getPage(pageNum);
    const wrap = $("#sealPlaceCanvasWrap");
    const containerWidth = wrap.clientWidth || 420;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(containerWidth / baseViewport.width, 1.4);
    const viewport = page.getViewport({ scale });
    const canvas = $("#sealPlaceCanvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    sealPlaceState.pageIndex = pageNum - 1;
    sealPlaceState.viewport = viewport;
    sealPlaceState.x = null;
    sealPlaceState.y = null;
    $("#sealPlaceMarker").style.display = "none";
    $("#confirmSealBtn").disabled = true;
  }
  await renderPage(pageCount);
  pageSelect.addEventListener("change", () => renderPage(Number(pageSelect.value)));

  $("#sealPlaceCanvas").addEventListener("click", (ev) => {
    const canvas = $("#sealPlaceCanvas");
    const wrap = $("#sealPlaceCanvasWrap");
    const canvasRect = canvas.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    // 실제 PDF 좌표 계산용 (캔버스 버퍼 픽셀 기준)
    const bufX = ((ev.clientX - canvasRect.left) / canvasRect.width) * canvas.width;
    const bufY = ((ev.clientY - canvasRect.top) / canvasRect.height) * canvas.height;
    sealPlaceState.x = bufX;
    sealPlaceState.y = bufY;

    // 화면 미리보기 마커 위치 (CSS 픽셀 기준)
    const marker = $("#sealPlaceMarker");
    const markerSize = 64;
    marker.style.width = markerSize + "px";
    marker.style.left = ev.clientX - wrapRect.left - markerSize / 2 + "px";
    marker.style.top = ev.clientY - wrapRect.top - markerSize / 2 + "px";
    marker.style.display = sealPlaceState.sealDataUrl ? "block" : "none";
    $("#confirmSealBtn").disabled = !sealPlaceState.sealDataUrl;
  });
}

async function stampAndSaveDocumentAt(state) {
  if (!state || state.x == null || state.y == null) {
    alert("도장을 찍을 위치를 미리보기에서 클릭해주세요.");
    return;
  }
  setSyncStatus("도장 찍는 중...", true);
  try {
    const { PDFDocument } = PDFLib;
    const c = await loadModule("corp");
    const seal = c.seals && c.seals[state.sealType];
    if (!seal || !seal.imageDataUrl) throw new Error("등록된 도장이 없어요.");

    const pdfDoc = await PDFDocument.load(state.pdfBytes);
    const sealBytes = await (await fetch(seal.imageDataUrl)).arrayBuffer();
    const sealImg = seal.imageDataUrl.startsWith("data:image/png")
      ? await pdfDoc.embedPng(sealBytes)
      : await pdfDoc.embedJpg(sealBytes);

    const page = pdfDoc.getPages()[state.pageIndex];
    const scale = state.viewport.scale;
    const pageHeightPts = state.viewport.height / scale;
    const pdfX = state.x / scale;
    const pdfY = pageHeightPts - state.y / scale;

    const sealHeight = 90;
    const sealWidth = sealHeight * (sealImg.width / sealImg.height);
    page.drawImage(sealImg, {
      x: pdfX - sealWidth / 2,
      y: pdfY - sealHeight / 2,
      width: sealWidth,
      height: sealHeight,
      opacity: 0.92,
    });

    const stampedBytes = await pdfDoc.save();
    const stampedBlob = new Blob([stampedBytes], { type: "application/pdf" });
    const baseName = state.fileName.replace(/\.[^.]+$/, "");
    const stampedFile = new File([stampedBlob], `${baseName}_날인.pdf`, { type: "application/pdf" });

    const uploaded = await Drive.uploadDocument(dataFolderId, stampedFile, null);

    const c2 = await loadModule("corp");
    c2.sealedDocs = c2.sealedDocs || [];
    c2.sealedDocs.unshift({
      id: uid(),
      name: stampedFile.name,
      sealLabel: seal.label || (state.sealType === "corporate" ? "법인인감" : "사용인감"),
      fileId: uploaded.id,
      webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
      createdAt: new Date().toISOString(),
    });
    await saveModule("corp", c2);
    refreshCurrentTab();
  } catch (err) {
    console.error(err);
    setSyncStatus("날인 실패", false);
    alert("도장 날인에 실패했어요: " + (err && err.message ? err.message : "알 수 없는 오류"));
  }
}

// ---------------- 탭별 이벤트 바인딩 ----------------
function bindTabEvents(tab) {
  if (tab === "dashboard") {
    $$("[data-quick]").forEach((b) => b.addEventListener("click", () => goTab(b.dataset.quick)));
  }

  if (tab === "corp") {
    $$("[data-corp-subtab]").forEach((b) =>
      b.addEventListener("click", () => {
        corpSubTab = b.dataset.corpSubtab;
        refreshCurrentTab();
      })
    );

    $("#editCorpBtn")?.addEventListener("click", async () => {
      const c = await loadModule("corp");
      openModal(Modules.corpEditForm(c));
      $("#saveCorpBtn").addEventListener("click", async () => {
        const c2 = await loadModule("corp");
        Object.assign(c2, {
          name: $("#f_name").value,
          engName: $("#f_engName").value,
          regNo: $("#f_regNo").value,
          bizNo: $("#f_bizNo").value,
          foundedDate: $("#f_foundedDate").value,
          capital: $("#f_capital").value,
          capitalShares: $("#f_capitalShares").value,
          parValue: $("#f_parValue").value,
          address: $("#f_address").value,
          meetings: {
            annual: $("#f_annual").value,
            special: $("#f_special").value,
            board: $("#f_board").value,
          },
          articleFlags: {
            thirdPartyIssue: $("#f_thirdPartyIssue").checked,
            preferredStock: $("#f_preferredStock").checked,
            stockOption: $("#f_stockOption").checked,
            transferRestriction: $("#f_transferRestriction").checked,
          },
        });
        await saveModule("corp", c2);
        closeModal();
        refreshCurrentTab();
      });
    });

    $("#addShareholderBtn")?.addEventListener("click", async () => {
      const name = prompt("주주 이름을 입력하세요");
      if (!name) return;
      const percent = prompt("지분율(%)을 입력하세요", "0");
      if (percent === null) return;
      const c = await loadModule("corp");
      c.shareholders.push({ name, percent });
      await saveModule("corp", c);
      refreshCurrentTab();
    });
    $$("[data-del-shareholder]").forEach((b) =>
      b.addEventListener("click", async () => {
        const c = await loadModule("corp");
        c.shareholders.splice(Number(b.dataset.delShareholder), 1);
        await saveModule("corp", c);
        refreshCurrentTab();
      })
    );

    $("#addOfficerBtn")?.addEventListener("click", async () => {
      const name = prompt("임원 이름을 입력하세요");
      if (!name) return;
      const role = prompt("직책을 입력하세요", "사내이사");
      if (role === null) return;
      const term = prompt("임기를 입력하세요 (선택)", "");
      const c = await loadModule("corp");
      c.officers.push({ name, role, term: term || "" });
      await saveModule("corp", c);
      refreshCurrentTab();
    });
    $$("[data-del-officer]").forEach((b) =>
      b.addEventListener("click", async () => {
        const c = await loadModule("corp");
        c.officers.splice(Number(b.dataset.delOfficer), 1);
        await saveModule("corp", c);
        refreshCurrentTab();
      })
    );

    $("#addBranchBtn")?.addEventListener("click", async () => {
      const addr = prompt("지점 주소를 입력하세요");
      if (!addr) return;
      const c = await loadModule("corp");
      c.branches.push(addr);
      await saveModule("corp", c);
      refreshCurrentTab();
    });
    $$("[data-del-branch]").forEach((b) =>
      b.addEventListener("click", async () => {
        const c = await loadModule("corp");
        c.branches.splice(Number(b.dataset.delBranch), 1);
        await saveModule("corp", c);
        refreshCurrentTab();
      })
    );

    $$(".doc-upload-input").forEach((input) =>
      input.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const key = input.dataset.docKey;
        setSyncStatus("서류 업로드 중...", true);
        try {
          const c = await loadModule("corp");
          const existing = c.documents[key] || {};
          const uploaded = await Drive.uploadDocument(dataFolderId, file, existing.fileId || null);
          c.documents[key] = {
            label: existing.label,
            fileId: uploaded.id,
            fileName: uploaded.name,
            webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
            updatedAt: new Date().toISOString(),
          };
          await saveModule("corp", c);
          refreshCurrentTab();
        } catch (err) {
          console.error(err);
          setSyncStatus("업로드 실패", false);
          alert("서류 업로드에 실패했어요. 파일 크기가 너무 크지 않은지 확인해주세요.");
        }
      })
    );

    $$(".ai-fill-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!CONFIG.AI_WORKER_URL) {
          alert("아직 AI 자동 채우기가 설정되지 않았어요. README.md의 'AI 자동 채우기 설정' 안내를 따라 설정해주세요.");
          return;
        }
        const key = btn.dataset.docKey;
        const c = await loadModule("corp");
        const doc = c.documents[key];
        if (!doc || !doc.fileId) return;
        const originalLabel = btn.textContent;
        btn.textContent = "분석 중...";
        btn.disabled = true;
        try {
          const fields = await aiExtractDocument(key, doc.fileId);
          openModal(Modules.aiReviewForm(doc.label, fields));
          $("#applyAiBtn").addEventListener("click", async () => {
            const c2 = await loadModule("corp");
            applyAiFields(c2, fields);
            await saveModule("corp", c2);
            closeModal();
            refreshCurrentTab();
          });
        } catch (err) {
          console.error(err);
          alert("AI 분석에 실패했어요: " + (err && err.message ? err.message : "알 수 없는 오류"));
        } finally {
          btn.textContent = originalLabel;
          btn.disabled = false;
        }
      })
    );

    // ---- 인감관리 하위탭 ----
    $$(".seal-upload-input").forEach((input) =>
      input.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) {
          alert("도장 이미지는 3MB 이하로 올려주세요.");
          e.target.value = "";
          return;
        }
        const sealType = input.dataset.sealType;
        setSyncStatus("인감 등록 중...", true);
        try {
          const dataUrl = await fileToDataUrl(file);
          const c = await loadModule("corp");
          c.seals[sealType] = {
            label: (c.seals[sealType] && c.seals[sealType].label) || (sealType === "corporate" ? "법인인감" : "사용인감"),
            imageDataUrl: dataUrl,
            updatedAt: new Date().toISOString(),
          };
          await saveModule("corp", c);
          refreshCurrentTab();
        } catch (err) {
          console.error(err);
          setSyncStatus("등록 실패", false);
          alert("인감 이미지 등록에 실패했어요.");
        }
      })
    );

    $$("[data-del-seal]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("등록된 인감을 삭제할까요?")) return;
        const sealType = b.dataset.delSeal;
        const c = await loadModule("corp");
        c.seals[sealType] = { label: c.seals[sealType] && c.seals[sealType].label, imageDataUrl: null, updatedAt: null };
        await saveModule("corp", c);
        refreshCurrentTab();
      })
    );

    $("#sealDocInput")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const c = await loadModule("corp");
      const hasSeal = (c.seals.corporate && c.seals.corporate.imageDataUrl) || (c.seals.usage && c.seals.usage.imageDataUrl);
      if (!hasSeal) {
        alert("먼저 법인인감 또는 사용인감을 등록해주세요.");
        e.target.value = "";
        return;
      }
      setSyncStatus("서류 불러오는 중...", true);
      try {
        await ensurePdfLibs();
        const pdfBytes = await toPdfBytes(file);
        setSyncStatus("동기화됨", false);
        openModal(Modules.sealPlaceForm(file.name, c.seals));
        await setupSealPlacer(pdfBytes, file.name, c.seals);
        $("#confirmSealBtn").addEventListener("click", async () => {
          const state = sealPlaceState;
          closeModal();
          await stampAndSaveDocumentAt(state);
        });
      } catch (err) {
        console.error(err);
        setSyncStatus("불러오기 실패", false);
        alert("서류를 불러오지 못했어요: " + (err && err.message ? err.message : "알 수 없는 오류"));
      }
      e.target.value = "";
    });

    $$("[data-download-sealed-doc]").forEach((b) =>
      b.addEventListener("click", async () => {
        const fileId = b.dataset.fileId;
        const fname = b.dataset.fileName || "document.pdf";
        b.disabled = true;
        try {
          const { base64, mimeType } = await Drive.downloadFileAsBase64(fileId);
          const bin = atob(base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: mimeType || "application/pdf" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fname;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error(err);
          alert("다운로드에 실패했어요.");
        } finally {
          b.disabled = false;
        }
      })
    );

    $$("[data-del-sealed-doc]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("목록에서 삭제할까요? (드라이브에 저장된 파일 자체는 남아있어요)")) return;
        const c = await loadModule("corp");
        c.sealedDocs = (c.sealedDocs || []).filter((d) => d.id !== b.dataset.id);
        await saveModule("corp", c);
        refreshCurrentTab();
      })
    );
  }

  if (tab === "notice") {
    $("#newNoticeBtn")?.addEventListener("click", () => {
      openModal(Modules.noticeForm());
      $("#saveNoticeBtn").addEventListener("click", async () => {
        const data = await loadModule("notice");
        data.items.push({
          id: uid(),
          title: $("#f_title").value || "(제목없음)",
          body: $("#f_body").value,
          pinned: $("#f_pinned").checked,
          author: ctx.user.name,
          date: todayStr(),
        });
        await saveModule("notice", data);
        closeModal();
        refreshCurrentTab();
      });
    });
    $$("[data-notice]").forEach((row) =>
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-del-notice]")) return;
        const body = $("#body_" + row.dataset.notice);
        body.style.display = body.style.display === "none" ? "block" : "none";
      })
    );
    $$("[data-del-notice]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const data = await loadModule("notice");
        data.items = data.items.filter((n) => n.id !== b.dataset.delNotice);
        await saveModule("notice", data);
        refreshCurrentTab();
      })
    );
  }

  if (tab === "calendar") {
    $("#newEventBtn")?.addEventListener("click", () => {
      openModal(Modules.eventForm());
      $("#saveEventBtn").addEventListener("click", async () => {
        const data = await loadModule("calendar");
        data.items.push({
          id: uid(),
          title: $("#f_title").value || "(제목없음)",
          date: $("#f_date").value || todayStr(),
          endDate: $("#f_endDate").value || "",
          memo: $("#f_memo").value,
        });
        await saveModule("calendar", data);
        closeModal();
        refreshCurrentTab();
      });
    });
    $$("[data-del-event]").forEach((b) =>
      b.addEventListener("click", async () => {
        const data = await loadModule("calendar");
        data.items = data.items.filter((e) => e.id !== b.dataset.delEvent);
        await saveModule("calendar", data);
        refreshCurrentTab();
      })
    );
  }

  if (tab === "approval") {
    $("#newApprovalBtn")?.addEventListener("click", () => {
      openModal(Modules.approvalForm());
      $("#saveApprovalBtn").addEventListener("click", async () => {
        const data = await loadModule("approval");
        data.items.push({
          id: uid(),
          type: $("#f_type").value,
          title: $("#f_title").value || "(제목없음)",
          body: $("#f_body").value,
          requester: ctx.user.email,
          approver: $("#f_approver").value.trim(),
          status: "대기",
          createdAt: nowStr(),
        });
        await saveModule("approval", data);
        closeModal();
        refreshCurrentTab();
      });
    });
    $$("[data-approval]").forEach((row) =>
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const body = $("#abody_" + row.dataset.approval);
        body.style.display = body.style.display === "none" ? "block" : "none";
      })
    );
    $$("[data-approve]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        await decideApproval(b.dataset.approve, "승인");
      })
    );
    $$("[data-reject]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        await decideApproval(b.dataset.reject, "반려");
      })
    );
  }

  if (tab === "attendance") {
    $("#checkInBtn")?.addEventListener("click", async () => {
      const data = await loadModule("attendance");
      data.checkins.push({
        id: uid(),
        email: ctx.user.email,
        name: ctx.user.name,
        date: todayStr(),
        checkIn: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
        checkOut: "",
      });
      await saveModule("attendance", data);
      refreshCurrentTab();
    });
    $("#checkOutBtn")?.addEventListener("click", async () => {
      const data = await loadModule("attendance");
      const rec = data.checkins.find((c) => c.email === ctx.user.email && c.date === todayStr());
      if (rec) rec.checkOut = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
      await saveModule("attendance", data);
      refreshCurrentTab();
    });
    $("#newLeaveBtn")?.addEventListener("click", () => {
      openModal(Modules.leaveForm());
      $("#saveLeaveBtn").addEventListener("click", async () => {
        const data = await loadModule("attendance");
        data.leaves.push({
          id: uid(),
          email: ctx.user.email,
          name: ctx.user.name,
          type: $("#f_type").value,
          startDate: $("#f_start").value,
          endDate: $("#f_end").value,
          reason: $("#f_reason").value,
          approver: $("#f_approver").value.trim(),
          status: "대기",
        });
        await saveModule("attendance", data);
        closeModal();
        refreshCurrentTab();
      });
    });
    $$("[data-leave-approve]").forEach((b) =>
      b.addEventListener("click", () => decideLeave(b.dataset.leaveApprove, "승인"))
    );
    $$("[data-leave-reject]").forEach((b) =>
      b.addEventListener("click", () => decideLeave(b.dataset.leaveReject, "반려"))
    );
  }

  if (tab === "sns") {
    $("#newSnsBtn")?.addEventListener("click", () => {
      openModal(Modules.snsForm());
      $("#saveSnsBtn").addEventListener("click", async () => {
        const data = await loadModule("sns");
        const date = $("#f_date").value || todayStr();
        const time = $("#f_time").value || "09:00";
        const newItem = {
          id: uid(),
          platform: $("#f_platform").value,
          title: $("#f_title").value || "(제목없음)",
          content: $("#f_content").value,
          assignee: $("#f_assignee").value,
          date,
          time,
          scheduledAt: `${date}T${time}`,
          autoPublish: $("#f_autoPublish").checked,
          calendarEventId: null,
          approver: $("#f_approver").value.trim(),
          status: "검토중",
        };
        data.items.push(newItem);
        await saveModule("sns", data);
        closeModal();
        refreshCurrentTab();
        if (pendingAiImageDataUrl || pendingAiVideoBlob) {
          const img = pendingAiImageDataUrl, vid = pendingAiVideoBlob;
          pendingAiImageDataUrl = null;
          pendingAiVideoBlob = null;
          attachAiMediaToSnsItem(newItem.id, img, vid);
        }
      });
    });
    $("#aiContentBtn")?.addEventListener("click", () => {
      openModal(Modules.aiContentForm());
      wireAiContentModal();
    });
    $$("[data-sns]").forEach((row) =>
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const body = $("#sbody_" + row.dataset.sns);
        body.style.display = body.style.display === "none" ? "block" : "none";
      })
    );
    $$("[data-sns-approve]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); decideSns(b.dataset.snsApprove, "승인"); }));
    $$("[data-sns-reject]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); decideSns(b.dataset.snsReject, "반려"); }));
    $$("[data-sns-publish]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); decideSns(b.dataset.snsPublish, "게시완료"); }));
    $$("[data-del-sns]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const data = await loadModule("sns");
        const target = data.items.find((s) => s.id === b.dataset.delSns);
        if (target?.calendarEventId) await removeSnsCalendarEvent(target.calendarEventId);
        data.items = data.items.filter((s) => s.id !== b.dataset.delSns);
        await saveModule("sns", data);
        refreshCurrentTab();
      })
    );
  }
}

async function decideApproval(id, status) {
  const data = await loadModule("approval");
  const item = data.items.find((a) => a.id === id);
  if (item) {
    item.status = status;
    item.decidedAt = nowStr();
  }
  await saveModule("approval", data);
  refreshCurrentTab();
}

async function decideLeave(id, status) {
  const data = await loadModule("attendance");
  const item = data.leaves.find((l) => l.id === id);
  if (item) item.status = status;
  await saveModule("attendance", data);
  refreshCurrentTab();
}

async function decideSns(id, status) {
  const data = await loadModule("sns");
  const item = data.items.find((s) => s.id === id);
  if (!item) return;
  item.status = status;
  if (status === "게시완료") item.publishedAt = nowStr();
  if (status === "승인" && item.autoPublish && item.scheduledAt) {
    item.calendarEventId = await syncSnsCalendarEvent(item);
  }
  if (status === "반려" && item.calendarEventId) {
    await removeSnsCalendarEvent(item.calendarEventId);
    item.calendarEventId = null;
  }
  await saveModule("sns", data);
  refreshCurrentTab();
}

// ---------------- SNS 예약 자동화 ----------------
// 승인 + "자동 게시 처리"가 켜진 콘텐츠는 캘린더에 자동으로 일정이 등록되고,
// 예정 시각이 지나면(앱이 열려있는 시점 기준) 자동으로 "게시완료"로 바뀌어요.
// 주의: 순수 프론트엔드 앱이라 브라우저 탭이 열려있어야 체크가 동작해요.
// 완전한 백그라운드 자동 게시(실제 SNS 플랫폼 업로드 포함)는 별도의 서버(Cloudflare
// Worker의 cron 트리거 등)와 각 플랫폼 API 연동이 필요해요 — 다음 단계 작업이에요.
async function syncSnsCalendarEvent(item) {
  const cal = await loadModule("calendar");
  let ev = item.calendarEventId ? cal.items.find((e) => e.id === item.calendarEventId) : null;
  if (!ev) {
    ev = { id: uid(), source: "sns", sourceId: item.id };
    cal.items.push(ev);
  }
  ev.title = `[SNS 예약] ${item.platform} · ${item.title}`;
  ev.date = item.date;
  ev.endDate = "";
  ev.memo = item.time ? `${item.time} 자동 게시 예정` : "자동 게시 예정";
  await saveModule("calendar", cal);
  return ev.id;
}

async function removeSnsCalendarEvent(eventId) {
  const cal = await loadModule("calendar");
  cal.items = cal.items.filter((e) => e.id !== eventId);
  await saveModule("calendar", cal);
}

async function runSnsAutoPublish() {
  if (!dataFolderId) return;
  try {
    const data = await loadModule("sns", true);
    const now = new Date();
    let changed = false;
    for (const item of data.items) {
      if (item.status === "승인" && item.autoPublish && item.scheduledAt && new Date(item.scheduledAt) <= now) {
        item.status = "게시완료";
        item.publishedAt = nowStr();
        changed = true;
      }
    }
    if (changed) {
      await saveModule("sns", data);
      if (["sns", "dashboard", "calendar"].includes(currentTab)) refreshCurrentTab();
    }
  } catch (e) {
    console.error("SNS 자동 게시 확인 실패", e);
  }
}
setInterval(runSnsAutoPublish, 5 * 60 * 1000);

// ---------------- AI로 SNS 콘텐츠 만들기 (문구 + 이미지 + 간단 동영상) ----------------
// 문구: Cloudflare Worker → Gemini 무료 티어 (/generate-text)
// 이미지: Pollinations.ai (완전 무료, 키/가입 불필요, 브라우저에서 바로 호출)
// 동영상: 생성된 이미지들을 캔버스에 그려서 MediaRecorder로 녹화하는 "슬라이드쇼" 방식
//         (진짜 AI 영상생성 API 중엔 상시 무료로 쓸 만한 게 마땅치 않아서, 100% 무료로
//         바로 되는 대안으로 구현했어요. 나중에 원하시면 실제 AI 영상 API로 교체 가능해요.)
function wireAiContentModal() {
  aiGalleryImages = [];
  aiSelectedImageDataUrl = null;
  aiVideoBlob = null;
  $("#genTextBtn").addEventListener("click", generateAiCaption);
  $("#genImageBtn").addEventListener("click", generateAiImage);
  $("#genVideoBtn").addEventListener("click", generateAiVideo);
  $("#useAiContentBtn").addEventListener("click", () => {
    const topic = $("#ai_topic").value.trim();
    const caption = $("#ai_caption")?.value?.trim() || "";
    const hashtags = $("#ai_hashtags")?.textContent?.trim() || "";
    const platform = $("#ai_platform").value;
    pendingAiImageDataUrl = aiSelectedImageDataUrl;
    pendingAiVideoBlob = aiVideoBlob;
    closeModal();
    $("#newSnsBtn").click();
    $("#f_title").value = topic || "(제목없음)";
    $("#f_content").value = caption ? caption + (hashtags ? "\n\n" + hashtags : "") : "";
    $$("#f_platform option").forEach((o) => {
      if (o.textContent === platform) $("#f_platform").value = platform;
    });
  });
}

async function generateAiCaption() {
  const btn = $("#genTextBtn");
  const topic = $("#ai_topic").value.trim();
  if (!topic) {
    alert("주제/키워드를 먼저 입력해주세요.");
    return;
  }
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "생성 중...";
  try {
    const res = await fetch(CONFIG.AI_WORKER_URL + "/generate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: $("#ai_platform").value, topic, tone: $("#ai_tone").value }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
    }
    $("#aiTextResult").style.display = "block";
    $("#ai_caption").value = data.caption || "";
    $("#ai_hashtags").textContent = (data.hashtags || []).map((h) => (h.startsWith("#") ? h : "#" + h)).join(" ");
  } catch (e) {
    alert("문구 생성에 실패했어요: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✍️ 문구 생성";
  }
}

async function generateAiImage() {
  const btn = $("#genImageBtn");
  const statusEl = $("#genImageStatus");
  const prompt = ($("#ai_imgPrompt").value || $("#ai_topic").value || "").trim();
  if (!prompt) {
    alert("이미지 프롬프트나 주제를 입력해주세요.");
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "생성 중... (몇 초 정도 걸려요)";
  try {
    let dataUrl = null;
    // 1순위: Cloudflare Workers AI (품질이 더 좋아요, Worker에 AI 바인딩이 있을 때만 동작)
    if (CONFIG.AI_WORKER_URL) {
      try {
        const res = await fetch(CONFIG.AI_WORKER_URL + "/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.image) {
          dataUrl = `data:${data.mimeType || "image/png"};base64,${data.image}`;
        }
      } catch (e) {
        // Worker 쪽 실패는 조용히 무시하고 아래 무료 대체 서비스로 넘어가요.
      }
    }
    // 2순위(항상 되는 대체): Pollinations.ai — 키/가입 없이 완전 무료
    if (!dataUrl) {
      const seed = Math.floor(Math.random() * 1e9);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("이미지 생성 서버 응답 오류 (" + res.status + ")");
      const blob = await res.blob();
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
    aiGalleryImages.push(dataUrl);
    if (!aiSelectedImageDataUrl) aiSelectedImageDataUrl = dataUrl;
    renderAiGallery();
    statusEl.textContent = "";
  } catch (e) {
    statusEl.textContent = "";
    alert("이미지 생성에 실패했어요: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderAiGallery() {
  const el = $("#aiImageGallery");
  if (!el) return;
  el.innerHTML = aiGalleryImages
    .map(
      (u, i) => `
    <div class="ai-thumb ${u === aiSelectedImageDataUrl ? "selected" : ""}" data-ai-thumb="${i}">
      <img src="${u}" alt="생성된 이미지">
      ${u === aiSelectedImageDataUrl ? '<span class="ai-thumb-badge">대표</span>' : ""}
    </div>`
    )
    .join("");
  $$("[data-ai-thumb]", el).forEach((t) =>
    t.addEventListener("click", () => {
      aiSelectedImageDataUrl = aiGalleryImages[Number(t.dataset.aiThumb)];
      renderAiGallery();
    })
  );
  const videoBtn = $("#genVideoBtn");
  if (videoBtn) videoBtn.disabled = aiGalleryImages.length < 2;
}

async function generateAiVideo() {
  const btn = $("#genVideoBtn");
  const statusEl = $("#genVideoStatus");
  if (aiGalleryImages.length < 2) return;
  btn.disabled = true;
  statusEl.textContent = "동영상 만드는 중... (이미지당 약 2초씩 걸려요)";
  try {
    const caption = ($("#ai_caption")?.value || $("#ai_topic").value || "").trim();
    aiVideoBlob = await buildSlideshowVideo(aiGalleryImages.slice(0, 5), caption);
    const url = URL.createObjectURL(aiVideoBlob);
    $("#aiVideoPreview").innerHTML = `<video src="${url}" controls style="max-width:100%; border-radius:8px; margin-top:8px;"></video>`;
    statusEl.textContent = "완성했어요! 아래에서 미리 확인해보세요.";
  } catch (e) {
    statusEl.textContent = "";
    alert("동영상 생성에 실패했어요: " + e.message + " (일부 브라우저에서는 지원하지 않을 수 있어요)");
  } finally {
    btn.disabled = false;
  }
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  const lines = [];
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 2);
  const startY = y - (shown.length - 1) * lineHeight;
  shown.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
}

// 이미지들을 캔버스에 순서대로 그려서 녹화한 간단한 슬라이드쇼 동영상(webm)을 만들어요.
async function buildSlideshowVideo(dataUrls, captionText) {
  const W = 720,
    H = 720;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(15);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });
  recorder.start();

  const imgs = await Promise.all(dataUrls.map(loadImageEl));
  const perImageMs = 2200;
  for (const img of imgs) {
    const start = Date.now();
    while (Date.now() - start < perImageMs) {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, W, H);
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale,
        dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      if (captionText) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, H - 90, W, 90);
        ctx.fillStyle = "#fff";
        ctx.font = "26px sans-serif";
        ctx.textAlign = "center";
        wrapCanvasText(ctx, captionText, W / 2, H - 55, W - 40, 30);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  recorder.stop();
  return done;
}

// 생성된 이미지/동영상을 드라이브에 실제 파일로 올리고, 그 링크를 해당 SNS 콘텐츠에 붙여줘요.
// (JSON 파일이 너무 커지지 않도록 이미지 자체는 sns.json에 넣지 않고, 드라이브 파일 링크만 저장해요.)
async function attachAiMediaToSnsItem(id, imageDataUrl, videoBlob) {
  try {
    const data = await loadModule("sns", true);
    const item = data.items.find((s) => s.id === id);
    if (!item) return;
    if (imageDataUrl) {
      const blob = await (await fetch(imageDataUrl)).blob();
      const file = new File([blob], `ai_image_${Date.now()}.png`, { type: blob.type || "image/png" });
      const uploaded = await Drive.uploadDocument(dataFolderId, file);
      item.imageFileId = uploaded.id;
      item.imageLink = uploaded.webViewLink || "";
    }
    if (videoBlob) {
      const file = new File([videoBlob], `ai_video_${Date.now()}.webm`, { type: "video/webm" });
      const uploaded = await Drive.uploadDocument(dataFolderId, file);
      item.videoFileId = uploaded.id;
      item.videoLink = uploaded.webViewLink || "";
    }
    await saveModule("sns", data);
    if (currentTab === "sns") refreshCurrentTab();
  } catch (e) {
    console.error("AI 콘텐츠 미디어 첨부 실패", e);
  }
}
