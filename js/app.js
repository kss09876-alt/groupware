// app.js — 로그인/폴더연결 흐름 + 탭 전환 + 각 모듈의 이벤트 처리

let dataFolderId = localStorage.getItem("gw_folderId") || null;
let currentTab = "dashboard";
let corpSubTab = "info"; // 법인정보 탭 내부 하위탭: "info" | "seal"
let snsSubTab = "content"; // SNS 탭 내부 하위탭: "content" | "trends" | "analytics"
const cache = {}; // 모듈별 로드된 데이터 캐시 (탭 전환 시 재사용, 저장 후 무효화)

// AI 콘텐츠 생성 모달의 임시 상태 (모달 열려있는 동안만 메모리에 보관)
let aiGalleryImages = []; // 생성된 이미지 dataURL 목록
let aiSelectedImageDataUrl = null; // 대표로 고른 이미지
let aiVideoBlob = null; // 생성된 슬라이드쇼 동영상
let aiNarrationBlob = null; // 생성된 릴스 나레이션 음성(mp3)
let storyboardScenes = []; // 콘티(스토리보드) 장면들: [{sceneNumber, narration, titleText, imageKeyword, mediaDataUrl, composedDataUrl}]

// 콘텐츠 스튜디오(팝업 대신 전용 페이지) 상태 — 지금 편집 중인 SNS 초안의 id와 자동저장 타이머
let studioDraftId = null;
let studioSaveTimer = null;
// 쇼츠 스튜디오(대본→콘티→완성 3단계 마법사)에서, 콘티가 만들어졌을 때 추가로 실행할 훅
let onStoryboardReadyHook = null;
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
    if (name === "sns") data = normalizeSns(data);
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
  get snsSubTab() {
    return snsSubTab;
  },
  get studioDraftId() {
    return studioDraftId;
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
  shorts: "쇼츠 스튜디오",
};

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    // 쇼츠 스튜디오는 일반 탭과 달리, 들어가는 순간 "작성중" 초안을 바로 만들어서
    // 실시간으로 저장되기 시작해야 하니 별도 진입 함수를 써요.
    if (btn.dataset.tab === "shorts") {
      enterShortsStudio();
    } else {
      goTab(btn.dataset.tab);
    }
    closeMobileSidebar();
  });
});

async function goTab(tab) {
  currentTab = tab;
  if (tab === "corp") corpSubTab = "info";
  if (tab === "sns") snsSubTab = "content";
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
    if (snsSubTab === "studio") {
      wireContentStudio();
    }
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
    $("#aiContentBtn")?.addEventListener("click", () => enterContentStudio(null));
    $$("[data-sns-continue]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        studioDraftId = b.dataset.snsContinue;
        snsSubTab = "studio";
        refreshCurrentTab();
      })
    );
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

    $$("[data-sns-subtab]").forEach((b) =>
      b.addEventListener("click", () => {
        snsSubTab = b.dataset.snsSubtab;
        refreshCurrentTab();
      })
    );

    // ---- 오늘의 추천 ----
    $("#fetchTrendsBtn")?.addEventListener("click", fetchDailyTrends);
    $$("[data-use-trend]").forEach((b) =>
      b.addEventListener("click", async () => {
        const data = await loadModule("sns");
        const t = (data.dailyTrends.items || [])[Number(b.dataset.useTrend)];
        if (t) useTrendAsContent(t);
      })
    );

    // ---- 목표/실적 ----
    $("#editGoalsBtn")?.addEventListener("click", async () => {
      const data = await loadModule("sns");
      openModal(Modules.goalsForm(data.goals));
      $("#saveGoalsBtn").addEventListener("click", async () => {
        const d2 = await loadModule("sns");
        d2.goals = {
          dailyFollowerGoal: $("#f_dailyFollowerGoal").value || "0",
          dailyViewGoal: $("#f_dailyViewGoal").value || "0",
        };
        await saveModule("sns", d2);
        closeModal();
        refreshCurrentTab();
      });
    });
    $$("[data-input-result]").forEach((b) =>
      b.addEventListener("click", async () => {
        const data = await loadModule("sns");
        const item = data.items.find((s) => s.id === b.dataset.inputResult);
        if (!item) return;
        openModal(Modules.resultForm(item));
        $("#saveResultBtn").addEventListener("click", async () => {
          const d2 = await loadModule("sns");
          const it2 = d2.items.find((s) => s.id === item.id);
          if (!it2) return;
          it2.actualFollowers = Number($("#f_actualFollowers").value) || 0;
          it2.actualViews = Number($("#f_actualViews").value) || 0;
          it2.resultUpdatedAt = nowStr();
          await saveModule("sns", d2);
          closeModal();
          refreshCurrentTab();
        });
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

// ---------------- 오늘의 추천 (AI 콘텐츠 아이디어 브레인스토밍) ----------------
// 외부 뉴스 API 없이, Worker가 Gemini에게 "아트아트(artart.today)" 스타일의
// 흥미로운 예술/디자인/컬처/라이프 콘텐츠 아이디어 10개를 매번 새로 만들어달라고 요청해요.
// 실시간 뉴스가 아니라 AI가 창작한 소재예요. 하루 1번 뽑아두면 그날은 재사용되고
// (sns.dailyTrends에 날짜와 함께 캐시), 버튼으로 언제든 다시 뽑을 수 있어요.
async function fetchDailyTrends() {
  const btn = $("#fetchTrendsBtn");
  const resultEl = $("#trendsResult");
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "아이디어 뽑는 중... (몇십 초 걸릴 수 있어요)";
  if (resultEl) resultEl.innerHTML = `<div class="loading">오늘의 아이디어를 만들고 있어요...</div>`;
  try {
    const corp = await loadModule("corp");
    const businessContext = corp.registeredPurposes && corp.registeredPurposes.length ? corp.registeredPurposes.join(", ") : corp.name || "";
    const location = corp.address || "";
    const res = await fetch(CONFIG.AI_WORKER_URL + "/daily-trends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessContext, location, today: todayStr() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
    }
    const sns = await loadModule("sns");
    sns.dailyTrends = { date: todayStr(), items: data.items || [], businessContext };
    await saveModule("sns", sns);
    refreshCurrentTab();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<div class="empty">아이디어 생성에 실패했어요: ${esc(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// 추천 카드에서 "이걸로 자동 콘텐츠 만들기"를 누르면, 콘텐츠 스튜디오 페이지로 넘어가서
// 주제/플랫폼/이미지 프롬프트를 채운 초안을 바로 만들고(콘텐츠 운영 목록에 즉시 나타나요),
// 이어서 문구 생성 → 이미지 생성까지 자동으로 실행해요.
async function useTrendAsContent(trend) {
  await enterContentStudio({
    title: trend.title,
    topic: trend.hook ? `${trend.title} — ${trend.hook}` : trend.title,
    platform: trend.platform,
    imagePrompt: trend.imagePrompt || trend.hook || trend.title,
  });
  await generateAiCaption();
  await generateAiImage();
}

// ---------------- AI로 SNS 콘텐츠 만들기 (문구 + 이미지 + 간단 동영상) ----------------
// 문구: Cloudflare Worker → Gemini 무료 티어 (/generate-text)
// 이미지: Pollinations.ai (완전 무료, 키/가입 불필요, 브라우저에서 바로 호출)
// 동영상: 생성된 이미지들을 캔버스에 그려서 MediaRecorder로 녹화하는 "슬라이드쇼" 방식
//         (진짜 AI 영상생성 API 중엔 상시 무료로 쓸 만한 게 마땅치 않아서, 100% 무료로
//         바로 되는 대안으로 구현했어요. 나중에 원하시면 실제 AI 영상 API로 교체 가능해요.)
// ---------------- 콘텐츠 스튜디오 ----------------
// 팝업창 대신 전용 페이지에서 AI 콘텐츠를 만들어요. 페이지에 들어가는 순간 "작성중" 상태의
// 초안을 드라이브에 바로 저장해서 "콘텐츠 운영" 목록에 즉시 나타나고, 이후 입력/생성한 내용도
// 자동으로(디바운스해서) 계속 저장돼요. 언제든 나갔다가 "✏️ 이어서 작성"으로 돌아올 수 있어요.
async function enterContentStudio(prefill) {
  const data = await loadModule("sns");
  const item = {
    id: uid(),
    platform: (prefill && prefill.platform) || "인스타그램",
    title: (prefill && prefill.title) || "(제목없음)",
    content: "",
    hashtags: "",
    topic: (prefill && prefill.topic) || "",
    tone: (prefill && prefill.tone) || "",
    imagePrompt: (prefill && prefill.imagePrompt) || "",
    script: "",
    assignee: "",
    date: todayStr(),
    time: "09:00",
    scheduledAt: `${todayStr()}T09:00`,
    autoPublish: true,
    calendarEventId: null,
    approver: "",
    status: "작성중",
    createdAt: nowStr(),
  };
  data.items.push(item);
  await saveModule("sns", data);
  studioDraftId = item.id;
  snsSubTab = "studio";
  await refreshCurrentTab();
}

// 쇼츠 스튜디오: 콘텐츠 스튜디오와 같은 "초안을 바로 만들어서 실시간 자동저장" 원리를
// 그대로 쓰되, 화면은 대본→콘티→완성 3단계 마법사로 보여줘요. 사이드바 탭 전용이라
// snsSubTab이 아니라 currentTab 자체를 "shorts"로 바꿔요.
async function enterShortsStudio() {
  const data = await loadModule("sns");
  const item = {
    id: uid(),
    platform: "인스타그램",
    title: "(제목없음)",
    content: "",
    hashtags: "",
    topic: "",
    tone: "교육형",
    imagePrompt: "",
    script: "",
    assignee: "",
    date: todayStr(),
    time: "09:00",
    scheduledAt: `${todayStr()}T09:00`,
    autoPublish: true,
    calendarEventId: null,
    approver: "",
    status: "작성중",
    createdAt: nowStr(),
  };
  data.items.push(item);
  await saveModule("sns", data);
  studioDraftId = item.id;
  aiGalleryImages = [];
  aiSelectedImageDataUrl = null;
  aiVideoBlob = null;
  aiNarrationBlob = null;
  storyboardScenes = [];
  currentTab = "shorts";
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === "shorts"));
  $("#pageTitle").textContent = TAB_TITLES.shorts;
  $("#content").innerHTML = `<div class="loading">불러오는 중...</div>`;
  const html = await Modules.shorts(ctx);
  $("#content").innerHTML = html;
  wireShortsStudio();
}

function goShortsStep(step) {
  [1, 2, 3].forEach((n) => {
    const panel = $("#shortsStep" + n);
    if (panel) panel.style.display = n === step ? "block" : "none";
    const dot = $(`[data-shorts-dot="${n}"]`);
    if (dot) {
      dot.classList.toggle("active", n === step);
      dot.classList.toggle("done", n < step);
    }
  });
}

function wireShortsStudio() {
  goShortsStep(1);
  onStoryboardReadyHook = () => goShortsStep(2);
  $("#genStoryboardBtn")?.addEventListener("click", generateStoryboard);
  $$("[data-shorts-back]").forEach((b) =>
    b.addEventListener("click", () => goShortsStep(Number(b.dataset.shortsBack)))
  );
  $("#shortsToStep3Btn")?.addEventListener("click", () => {
    if (!storyboardScenes.length) {
      alert("먼저 콘티를 만들고 장면 이미지를 골라주세요.");
      return;
    }
    const missing = storyboardScenes.filter((s) => !s.composedDataUrl);
    if (missing.length) {
      alert(`아직 이미지를 고르지 않은 장면이 ${missing.length}개 있어요.`);
      return;
    }
    goShortsStep(3);
  });
  $("#assembleSetBtn")?.addEventListener("click", assembleContentSet);
  $("#ai_topic")?.addEventListener("input", scheduleStudioAutosave);
  $("#ai_tone")?.addEventListener("change", scheduleStudioAutosave);
  $("#ai_script")?.addEventListener("input", scheduleStudioAutosave);
  $("#ai_approver")?.addEventListener("input", scheduleStudioAutosave);
  $("#shortsSubmitBtn")?.addEventListener("click", async () => {
    if (!aiVideoBlob && !aiSelectedImageDataUrl) {
      alert("먼저 '릴스+게시물 세트로 완성하기'를 눌러 콘텐츠를 완성해주세요.");
      return;
    }
    await saveStudioDraftNow();
    const data = await loadModule("sns", true);
    const item = data.items.find((s) => s.id === studioDraftId);
    if (!item) return;
    if (!item.approver) {
      alert("승인자 이메일을 입력해주세요.");
      return;
    }
    if (item.title === "(제목없음)" && item.topic) item.title = item.topic;
    item.status = "검토중";
    await saveModule("sns", data);
    studioDraftId = null;
    onStoryboardReadyHook = null;
    snsSubTab = "content";
    goTab("sns");
  });
}

function wireContentStudio() {
  aiGalleryImages = [];
  aiSelectedImageDataUrl = null;
  aiVideoBlob = null;
  aiNarrationBlob = null;
  storyboardScenes = [];
  onStoryboardReadyHook = null;
  $("#studioBackBtn")?.addEventListener("click", async () => {
    await saveStudioDraftNow();
    snsSubTab = "content";
    refreshCurrentTab();
  });
  $("#studioDeleteBtn")?.addEventListener("click", async () => {
    if (!confirm("이 초안을 삭제할까요? 되돌릴 수 없어요.")) return;
    const data = await loadModule("sns", true);
    data.items = data.items.filter((s) => s.id !== studioDraftId);
    await saveModule("sns", data);
    studioDraftId = null;
    snsSubTab = "content";
    refreshCurrentTab();
  });
  $("#studioSubmitBtn")?.addEventListener("click", async () => {
    await saveStudioDraftNow();
    const data = await loadModule("sns", true);
    const item = data.items.find((s) => s.id === studioDraftId);
    if (!item) return;
    if (!item.approver) {
      alert("승인자 이메일을 입력해주세요.");
      return;
    }
    item.status = "검토중";
    await saveModule("sns", data);
    studioDraftId = null;
    snsSubTab = "content";
    refreshCurrentTab();
  });

  ["ai_platform", "ai_title", "ai_assignee", "ai_date", "ai_time", "ai_autoPublish", "ai_approver", "ai_topic", "ai_tone", "ai_imgPrompt", "ai_script", "ai_caption"].forEach(
    (id) => {
      const el = $("#" + id);
      if (!el) return;
      el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" || el.type === "date" || el.type === "time" ? "change" : "input", scheduleStudioAutosave);
    }
  );

  $("#genTextBtn").addEventListener("click", generateAiCaption);
  $("#genImageBtn").addEventListener("click", generateAiImage);
  $("#genVideoBtn").addEventListener("click", generateAiVideo);
  $("#genNarrationBtn")?.addEventListener("click", generateAiNarration);
  $("#searchPexelsPhotoBtn")?.addEventListener("click", () => searchPexelsMedia("photos"));
  $("#searchPexelsVideoBtn")?.addEventListener("click", () => searchPexelsMedia("videos"));
  $("#composeCardBtn")?.addEventListener("click", composeCardImage);
  $("#genStoryboardBtn")?.addEventListener("click", generateStoryboard);
  $("#assembleSetBtn")?.addEventListener("click", assembleContentSet);
  $("#ai_imageFile")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    aiGalleryImages = [dataUrl, ...aiGalleryImages];
    aiSelectedImageDataUrl = dataUrl;
    renderAiGallery();
    const statusEl = $("#aiLocalMediaStatus");
    if (statusEl) statusEl.textContent = `📎 사진 첨부됨: ${file.name}`;
    syncStudioMedia();
  });
  $("#ai_videoFile")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    aiVideoBlob = file;
    const url = URL.createObjectURL(file);
    const preview = $("#aiVideoPreview");
    if (preview) preview.innerHTML = `<video src="${url}" controls style="max-width:100%; border-radius:8px; margin-top:8px;"></video>`;
    const statusEl = $("#aiLocalMediaStatus");
    if (statusEl) statusEl.textContent = (statusEl.textContent ? statusEl.textContent + " · " : "") + `📎 영상 첨부됨: ${file.name}`;
    syncStudioMedia();
  });
}

// 메타/문구/주제 등 텍스트 필드는 타이핑이 멈추고 나서 잠깐(0.9초) 뒤에 자동 저장돼요
// (매 키 입력마다 드라이브에 쓰지 않도록 디바운스했어요).
function scheduleStudioAutosave() {
  if (!studioDraftId) return;
  const statusEl = $("#studioSaveStatus");
  if (statusEl) statusEl.textContent = "저장 대기 중...";
  clearTimeout(studioSaveTimer);
  studioSaveTimer = setTimeout(saveStudioDraftNow, 900);
}

async function saveStudioDraftNow() {
  if (!studioDraftId) return;
  const statusEl = $("#studioSaveStatus");
  try {
    const data = await loadModule("sns", true);
    const item = data.items.find((s) => s.id === studioDraftId);
    if (!item) return;
    item.platform = $("#ai_platform")?.value || item.platform;
    item.title = $("#ai_title")?.value.trim() || "(제목없음)";
    item.assignee = $("#ai_assignee")?.value || "";
    item.date = $("#ai_date")?.value || item.date;
    item.time = $("#ai_time")?.value || item.time;
    item.scheduledAt = `${item.date}T${item.time}`;
    item.autoPublish = $("#ai_autoPublish") ? $("#ai_autoPublish").checked : item.autoPublish;
    item.approver = $("#ai_approver")?.value.trim() || "";
    item.topic = $("#ai_topic")?.value || "";
    item.tone = $("#ai_tone")?.value || "";
    item.content = $("#ai_caption")?.value || "";
    item.hashtags = $("#ai_hashtags")?.textContent || "";
    item.imagePrompt = $("#ai_imgPrompt")?.value || "";
    item.script = $("#ai_script")?.value || "";
    await saveModule("sns", data);
    if (statusEl) statusEl.textContent = "자동 저장됨 · " + new Date().toLocaleTimeString("ko-KR");
  } catch (e) {
    if (statusEl) statusEl.textContent = "저장 실패";
    console.error("스튜디오 자동 저장 실패", e);
  }
}

// 대표 이미지/영상이 바뀔 때마다 드라이브에 실제 파일로 올려서 초안에 바로 붙여줘요.
function syncStudioMedia() {
  if (!studioDraftId) return;
  attachAiMediaToSnsItem(studioDraftId, aiSelectedImageDataUrl, aiVideoBlob);
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
    scheduleStudioAutosave();
  } catch (e) {
    alert("문구 생성에 실패했어요: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✍️ 문구 생성";
  }
}

// 릴스 나레이션 음성 생성 — Cloudflare Workers AI(MeloTTS, 무료)를 시도해요.
// 이 Worker에 Workers AI 바인딩이 없거나 한국어를 지원하지 않으면 실패할 수 있는데,
// 그래도 문구/이미지 생성이나 동영상 만들기는 그대로 계속 쓸 수 있게 조용히 안내만 해요.
async function generateAiNarration() {
  const btn = $("#genNarrationBtn");
  const statusEl = $("#genNarrationStatus");
  const text = ($("#ai_caption")?.value || $("#ai_topic").value || "").trim();
  if (!text) {
    alert("먼저 문구를 생성하거나 입력해주세요.");
    return;
  }
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "음성 만드는 중...";
  try {
    const res = await fetch(CONFIG.AI_WORKER_URL + "/generate-speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 800) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      let detail = (data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")";
      if (data && data.elevenLabsError) detail += `\nElevenLabs: ${data.elevenLabsError.status} ${data.elevenLabsError.detail}`;
      if (data && data.melottsAttempts) detail += "\nMeloTTS: " + data.melottsAttempts.map((a) => `${a.lang}(${a.detail})`).join(", ");
      throw new Error(detail);
    }
    const byteChars = atob(data.audio);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    aiNarrationBlob = new Blob([bytes], { type: data.mimeType || "audio/mpeg" });
    const url = URL.createObjectURL(aiNarrationBlob);
    $("#aiNarrationPreview").innerHTML = `<audio src="${url}" controls style="margin-top:8px;"></audio>`;
    statusEl.textContent = data.provider === "elevenlabs" ? "완성했어요! (ElevenLabs)" : "완성했어요!";
  } catch (e) {
    statusEl.textContent = "";
    aiNarrationBlob = null;
    alert("나레이션 음성 생성에 실패했어요: " + e.message + "\n(음성 없이 계속 진행하셔도 돼요.)");
  } finally {
    btn.disabled = false;
  }
}

// Pexels에서 실제 사진/영상을 검색해서 가져와요 — 완전 무료 스톡 사진/영상 서비스라
// AI 생성 이미지보다 실사 느낌이 필요할 때, 또는 저작권 걱정 없는 소스가 필요할 때 유용해요.
async function searchPexelsMedia(type) {
  const statusEl = $("#pexelsStatus");
  const resultsEl = $("#pexelsResults");
  const query = ($("#ai_pexelsQuery")?.value || $("#ai_imgPrompt")?.value || $("#ai_topic")?.value || "").trim();
  if (!query) {
    alert("검색어나 주제를 먼저 입력해주세요.");
    return;
  }
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  statusEl.textContent = "검색 중...";
  resultsEl.innerHTML = "";
  try {
    const res = await fetch(CONFIG.AI_WORKER_URL + "/search-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, type, perPage: 8 }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
    }
    const items = data.items || [];
    if (!items.length) {
      statusEl.textContent = "검색 결과가 없어요.";
      return;
    }
    statusEl.textContent = `${items.length}개 찾았어요. 클릭해서 선택하세요.`;
    resultsEl.innerHTML = items
      .map(
        (it, i) => `
      <div class="ai-thumb" data-pexels-item="${i}">
        <img src="${it.thumb}" alt="Pexels ${type === "videos" ? "영상" : "사진"}">
        ${type === "videos" ? `<span class="ai-thumb-badge">${Math.round(it.duration || 0)}초</span>` : ""}
      </div>`
      )
      .join("");
    $$("[data-pexels-item]", resultsEl).forEach((el) =>
      el.addEventListener("click", () => selectPexelsItem(items[Number(el.dataset.pexelsItem)], type, statusEl))
    );
  } catch (e) {
    statusEl.textContent = "";
    alert("Pexels 검색에 실패했어요: " + e.message);
  }
}

async function selectPexelsItem(item, type, statusEl) {
  statusEl.textContent = "가져오는 중...";
  try {
    if (type === "videos") {
      const res = await fetch(item.videoUrl);
      const blob = await res.blob();
      aiVideoBlob = blob;
      const url = URL.createObjectURL(blob);
      $("#aiVideoPreview").innerHTML = `<video src="${url}" controls style="max-width:100%; border-radius:8px; margin-top:8px;"></video>`;
      statusEl.textContent = `가져왔어요! (촬영: ${item.credit || "Pexels"})`;
      syncStudioMedia();
    } else {
      const res = await fetch(item.imageUrl);
      const blob = await res.blob();
      const dataUrl = await fileToDataUrl(blob);
      aiGalleryImages = [dataUrl, ...aiGalleryImages];
      aiSelectedImageDataUrl = dataUrl;
      renderAiGallery();
      statusEl.textContent = `가져왔어요! (촬영: ${item.credit || "Pexels"})`;
      syncStudioMedia();
    }
  } catch (e) {
    statusEl.textContent = "";
    alert("가져오기에 실패했어요: " + e.message);
  }
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function wrapTextLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || "").split(" ").filter(Boolean);
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
  return lines.slice(0, maxLines);
}

// 사진 위에 "지금 99%가 모르는..." 스타일의 카드뉴스 자막(상단 검은 띠 + 큼직한 타이틀)을 합성해요.
async function composeTitleOverlay(imageDataUrl, titleText, fontSizePx, color) {
  const img = await loadImageEl(imageDataUrl);
  const W = 720,
    H = 900;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const fontSize = Math.max(20, Number(fontSizePx) || 48);
  const textColor = color || "#ffffff";
  ctx.font = `bold ${fontSize}px sans-serif`;
  const maxTextWidth = W - 60;
  const lineHeight = fontSize * 1.25;
  const lines = wrapTextLines(ctx, (titleText || "").trim() || "제목", maxTextWidth, 3);
  const bandPadding = 36;
  const bandHeight = Math.min(H * 0.6, Math.max(140, lines.length * lineHeight + bandPadding * 2));

  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(0, 0, W, bandHeight);

  const photoH = H - bandHeight;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bandHeight, W, photoH);
  ctx.clip();
  const scale = Math.max(W / img.width, photoH / img.height);
  const dw = img.width * scale,
    dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, bandHeight + (photoH - dh) / 2, dw, dh);
  ctx.restore();

  ctx.fillStyle = textColor;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const startY = (bandHeight - lines.length * lineHeight) / 2 + fontSize * 0.85;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * lineHeight));

  return canvas.toDataURL("image/png");
}

// 지금 선택된 대표 이미지에 타이틀 자막을 얹어서 새 이미지로 갤러리에 추가해요.
async function composeCardImage() {
  const statusEl = $("#composeCardStatus");
  if (!aiSelectedImageDataUrl) {
    alert("먼저 위에서 이미지를 생성하거나 선택해주세요.");
    return;
  }
  const title = $("#ai_cardTitle")?.value.trim() || $("#ai_topic").value.trim();
  const fontSize = $("#ai_cardFontSize")?.value || 48;
  const color = $("#ai_cardColor")?.value || "#ffffff";
  statusEl.textContent = "합성 중...";
  try {
    const composed = await composeTitleOverlay(aiSelectedImageDataUrl, title, fontSize, color);
    aiGalleryImages.push(composed);
    aiSelectedImageDataUrl = composed;
    renderAiGallery();
    statusEl.textContent = "완료! 갤러리에 추가됐어요.";
    syncStudioMedia();
  } catch (e) {
    statusEl.textContent = "";
    alert("합성에 실패했어요: " + e.message);
  }
}

// 스크립트(또는 주제)를 AI로 장면별 콘티로 나눠요. 각 장면은 나레이션 + 화면 자막 + 이미지 검색용 키워드로 구성돼요.
async function generateStoryboard() {
  const btn = $("#genStoryboardBtn");
  const statusEl = $("#storyboardStatus");
  const topic = $("#ai_topic").value.trim();
  const script = $("#ai_script")?.value.trim() || "";
  if (!topic && !script) {
    alert("주제나 스크립트를 먼저 입력해주세요.");
    return;
  }
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "콘티 만드는 중...";
  try {
    const sceneCount = $("#ai_sceneCount")?.value || 5;
    const genre = $("#ai_tone")?.value || "";
    // 지금까지 게시완료된 콘텐츠 중 반응이 좋았던 것들을 참고자료로 같이 넘겨서, 추천이 실제
    // 실적 데이터를 반영하게 해요(실적이 쌓일수록 더 정교해져요).
    let pastPerformanceHint = "";
    try {
      const sns = await loadModule("sns");
      const top = [...sns.items]
        .filter((s) => s.status === "게시완료")
        .sort((a, b) => (Number(b.actualViews) || 0) - (Number(a.actualViews) || 0))
        .slice(0, 3);
      if (top.length) pastPerformanceHint = top.map((t) => t.title).join(", ");
    } catch (e) {
      // 실적 데이터 조회 실패는 조용히 무시하고 힌트 없이 계속 진행해요.
    }
    const res = await fetch(CONFIG.AI_WORKER_URL + "/generate-storyboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, script, sceneCount, genre, pastPerformanceHint }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
    }
    storyboardScenes = (data.scenes || []).map((s) => ({ ...s, mediaDataUrl: null, composedDataUrl: null }));
    renderStoryboard();
    const row = $("#storyboardAssembleRow");
    if (row) row.style.display = "flex";
    statusEl.textContent = `${storyboardScenes.length}개 장면을 만들었어요. 각 장면마다 이미지를 골라주세요.`;
    if (onStoryboardReadyHook) onStoryboardReadyHook();
  } catch (e) {
    statusEl.textContent = "";
    alert("콘티 생성에 실패했어요: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderStoryboard() {
  const el = $("#storyboardScenes");
  if (!el) return;
  el.innerHTML = storyboardScenes
    .map(
      (s, i) => `
    <div class="storyboard-scene" data-scene-idx="${i}">
      <div class="storyboard-scene-head">#${s.sceneNumber}</div>
      <label style="display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--muted); font-weight:600;">
        나레이션
        <textarea rows="2" data-scene-field="narration" data-scene-idx="${i}">${escHtml(s.narration)}</textarea>
      </label>
      <label style="display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--muted); font-weight:600; margin-top:6px;">
        화면 자막(타이틀)
        <input data-scene-field="titleText" data-scene-idx="${i}" value="${escHtml(s.titleText)}">
      </label>
      <p class="hint" style="margin:6px 0;">🔎 ${escHtml(s.imageKeyword)}</p>
      <div class="modal-actions" style="justify-content:flex-start;">
        <button class="btn btn-secondary btn-tiny" data-scene-ai="${i}">🎨 AI 이미지</button>
        <button class="btn btn-secondary btn-tiny" data-scene-pexels="${i}">📷 Pexels 추천</button>
        <label class="btn btn-secondary btn-tiny" style="cursor:pointer;">📎 업로드<input type="file" accept="image/*" data-scene-upload="${i}" style="display:none;"></label>
        <span class="muted" data-scene-status="${i}"></span>
      </div>
      <div class="ai-image-gallery" data-scene-options="${i}"></div>
      <div data-scene-preview="${i}"></div>
    </div>`
    )
    .join("");

  $$("[data-scene-field]", el).forEach((f) =>
    f.addEventListener("input", () => {
      const i = Number(f.dataset.sceneIdx);
      storyboardScenes[i][f.dataset.sceneField] = f.value;
    })
  );
  $$("[data-scene-ai]", el).forEach((b) => b.addEventListener("click", () => sceneGenerateAiImage(Number(b.dataset.sceneAi))));
  $$("[data-scene-pexels]", el).forEach((b) => b.addEventListener("click", () => sceneSearchPexels(Number(b.dataset.scenePexels))));
  $$("[data-scene-upload]", el).forEach((inp) =>
    inp.addEventListener("change", async (e) => {
      const i = Number(inp.dataset.sceneUpload);
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      await sceneSetMedia(i, dataUrl);
    })
  );
}

// 선택된 원본 이미지에 그 장면의 타이틀 자막을 입혀서 미리보기와 상태를 갱신해요.
async function sceneSetMedia(i, rawDataUrl) {
  const statusEl = $(`[data-scene-status="${i}"]`);
  if (statusEl) statusEl.textContent = "자막 합성 중...";
  try {
    const fontSize = $("#ai_titleFontSize")?.value || 48;
    const composed = await composeTitleOverlay(rawDataUrl, storyboardScenes[i].titleText, fontSize, "#ffffff");
    storyboardScenes[i].mediaDataUrl = rawDataUrl;
    storyboardScenes[i].composedDataUrl = composed;
    const previewEl = $(`[data-scene-preview="${i}"]`);
    if (previewEl) previewEl.innerHTML = `<img src="${composed}" style="max-width:160px; border-radius:8px; margin-top:6px;">`;
    if (statusEl) statusEl.textContent = "완료";
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    alert("이미지 합성에 실패했어요: " + e.message);
  }
}

async function sceneGenerateAiImage(i) {
  const statusEl = $(`[data-scene-status="${i}"]`);
  if (statusEl) statusEl.textContent = "생성 중...";
  try {
    const prompt = storyboardScenes[i].imageKeyword || storyboardScenes[i].titleText || "";
    let dataUrl = null;
    if (CONFIG.AI_WORKER_URL) {
      try {
        const res = await fetch(CONFIG.AI_WORKER_URL + "/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.image) dataUrl = `data:${data.mimeType || "image/png"};base64,${data.image}`;
      } catch (e) {
        // Worker 실패는 조용히 무시하고 아래 무료 대체 서비스로 넘어가요.
      }
    }
    if (!dataUrl) {
      const seed = Math.floor(Math.random() * 1e9);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("이미지 생성 서버 응답 오류 (" + res.status + ")");
      const blob = await res.blob();
      dataUrl = await fileToDataUrl(blob);
    }
    await sceneSetMedia(i, dataUrl);
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    alert("장면 이미지 생성에 실패했어요: " + e.message);
  }
}

async function sceneSearchPexels(i) {
  const statusEl = $(`[data-scene-status="${i}"]`);
  const optionsEl = $(`[data-scene-options="${i}"]`);
  const query = storyboardScenes[i].imageKeyword || storyboardScenes[i].titleText || "";
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  if (statusEl) statusEl.textContent = "검색 중...";
  if (optionsEl) optionsEl.innerHTML = "";
  try {
    const res = await fetch(CONFIG.AI_WORKER_URL + "/search-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, type: "photos", perPage: 6 }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
    }
    const items = data.items || [];
    if (!items.length) {
      if (statusEl) statusEl.textContent = "검색 결과가 없어요.";
      return;
    }
    if (statusEl) statusEl.textContent = "클릭해서 선택하세요.";
    if (optionsEl) {
      optionsEl.innerHTML = items
        .map((it, j) => `<div class="ai-thumb" data-scene-pexels-item="${j}"><img src="${it.thumb}" alt="Pexels 사진"></div>`)
        .join("");
      $$("[data-scene-pexels-item]", optionsEl).forEach((elm) =>
        elm.addEventListener("click", async () => {
          const item = items[Number(elm.dataset.scenePexelsItem)];
          if (statusEl) statusEl.textContent = "가져오는 중...";
          try {
            const r = await fetch(item.imageUrl);
            const blob = await r.blob();
            const dataUrl = await fileToDataUrl(blob);
            await sceneSetMedia(i, dataUrl);
            if (statusEl) statusEl.textContent = `가져왔어요! (촬영: ${item.credit || "Pexels"})`;
          } catch (e) {
            if (statusEl) statusEl.textContent = "";
            alert("가져오기에 실패했어요: " + e.message);
          }
        })
      );
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    alert("Pexels 검색에 실패했어요: " + e.message);
  }
}

// 모든 장면에 이미지가 준비되면, 그 장면 이미지들로 "일반 게시물용 대표 이미지 + 릴스 영상"을
// 한 세트로 자동 완성해요 (기존 이미지 갤러리/나레이션/슬라이드쇼 로직을 그대로 재사용해요).
async function assembleContentSet() {
  const btn = $("#assembleSetBtn");
  const statusEl = $("#assembleSetStatus");
  if (!storyboardScenes.length) return;
  const missing = storyboardScenes.filter((s) => !s.composedDataUrl);
  if (missing.length) {
    alert(`아직 이미지를 고르지 않은 장면이 ${missing.length}개 있어요. 모든 장면에 이미지를 먼저 골라주세요.`);
    return;
  }
  btn.disabled = true;
  try {
    statusEl.textContent = "게시물용 대표 이미지 설정 중...";
    aiGalleryImages = storyboardScenes.map((s) => s.composedDataUrl);
    aiSelectedImageDataUrl = aiGalleryImages[0];
    renderAiGallery();

    if (CONFIG.AI_WORKER_URL) {
      statusEl.textContent = "나레이션 음성 만드는 중...";
      const combinedNarration = storyboardScenes
        .map((s) => s.narration)
        .join(" ")
        .trim()
        .slice(0, 800);
      if (combinedNarration) {
        try {
          const res = await fetch(CONFIG.AI_WORKER_URL + "/generate-speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: combinedNarration }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok && data && data.audio) {
            const byteChars = atob(data.audio);
            const bytes = new Uint8Array(byteChars.length);
            for (let k = 0; k < byteChars.length; k++) bytes[k] = byteChars.charCodeAt(k);
            aiNarrationBlob = new Blob([bytes], { type: data.mimeType || "audio/mpeg" });
            const url = URL.createObjectURL(aiNarrationBlob);
            const preview = $("#aiNarrationPreview");
            if (preview) preview.innerHTML = `<audio src="${url}" controls style="margin-top:8px;"></audio>`;
            if ($("#aiTextResult")) $("#aiTextResult").style.display = "block";
          }
        } catch (e) {
          // 나레이션 실패해도 슬라이드쇼는 음성 없이 계속 만들어요.
        }
      }
    }

    statusEl.textContent = "릴스 영상 만드는 중...";
    const caption = ($("#ai_caption")?.value || $("#ai_topic").value || "").trim();
    aiVideoBlob = await buildSlideshowVideo(aiGalleryImages.slice(0, 8), caption, aiNarrationBlob);
    const url = URL.createObjectURL(aiVideoBlob);
    const preview = $("#aiVideoPreview");
    if (preview) preview.innerHTML = `<video src="${url}" controls style="max-width:100%; border-radius:8px; margin-top:8px;"></video>`;
    syncStudioMedia();

    statusEl.textContent = "완성했어요! 게시물용 대표 이미지와 릴스 영상이 모두 준비되어 자동 저장됐어요. 필요하면 위 문구를 다듬고 '검토요청으로 등록'을 눌러주세요.";
  } catch (e) {
    statusEl.textContent = "";
    alert("세트 만들기에 실패했어요: " + e.message);
  } finally {
    btn.disabled = false;
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
    syncStudioMedia();
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
      syncStudioMedia();
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
  statusEl.textContent = aiNarrationBlob
    ? "동영상 만드는 중... (나레이션 길이에 맞춰요)"
    : "동영상 만드는 중... (이미지당 약 2초씩 걸려요)";
  try {
    const caption = ($("#ai_caption")?.value || $("#ai_topic").value || "").trim();
    aiVideoBlob = await buildSlideshowVideo(aiGalleryImages.slice(0, 5), caption, aiNarrationBlob);
    const url = URL.createObjectURL(aiVideoBlob);
    $("#aiVideoPreview").innerHTML = `<video src="${url}" controls style="max-width:100%; border-radius:8px; margin-top:8px;"></video>`;
    statusEl.textContent = aiNarrationBlob ? "완성했어요! 음성이 입혀졌어요." : "완성했어요! 아래에서 미리 확인해보세요.";
    syncStudioMedia();
  } catch (e) {
    statusEl.textContent = "";
    alert("동영상 생성에 실패했어요: " + e.message + " (일부 브라우저에서는 지원하지 않을 수 있어요)");
  } finally {
    btn.disabled = false;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
// audioBlob이 있으면(릴스 나레이션) 실제로 재생하면서 그 소리를 함께 녹화하고,
// 전체 길이도 나레이션 길이에 맞춰 이미지 노출 시간을 자동으로 늘려요.
async function buildSlideshowVideo(dataUrls, captionText, audioBlob) {
  const W = 720,
    H = 720;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const videoStream = canvas.captureStream(15);

  let combinedStream = videoStream;
  let audioEl = null;
  let totalMs = dataUrls.length * 2200;

  if (audioBlob) {
    audioEl = new Audio(URL.createObjectURL(audioBlob));
    try {
      await new Promise((resolve, reject) => {
        audioEl.addEventListener("loadedmetadata", resolve, { once: true });
        audioEl.addEventListener("error", reject, { once: true });
        audioEl.load();
      });
      if (audioEl.duration && isFinite(audioEl.duration)) {
        totalMs = Math.min(Math.max(audioEl.duration * 1000 + 300, dataUrls.length * 1200), 60000);
      }
      const AudioContextCls = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextCls();
      const source = audioCtx.createMediaElementSource(audioEl);
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);
      combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    } catch (e) {
      // 오디오 트랙 준비에 실패하면 음성 없이 화면 녹화만 계속해요.
      combinedStream = videoStream;
      audioEl = null;
    }
  }

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const recorder = new MediaRecorder(combinedStream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });
  recorder.start();
  if (audioEl) {
    try {
      await audioEl.play();
    } catch (e) {
      // 자동재생이 막히면 화면만 녹화되고 음성은 빠질 수 있어요.
    }
  }

  const imgs = await Promise.all(dataUrls.map(loadImageEl));
  const perImageMs = Math.max(1200, totalMs / imgs.length);
  const FADE_MS = 350; // 장면이 바뀔 때 검은 화면에서 자연스럽게 페이드인되는 시간
  for (const img of imgs) {
    const start = Date.now();
    while (Date.now() - start < perImageMs) {
      const elapsed = Date.now() - start;
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
      // 장면 전환 페이드: 이 이미지가 나온 지 얼마 안 됐으면(FADE_MS 이내) 검은 오버레이를
      // 점점 옅어지게 덮어씌워서, 컷 전환이 아니라 자연스럽게 밝아지는 느낌을 줘요.
      if (elapsed < FADE_MS) {
        const alpha = 1 - elapsed / FADE_MS;
        ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(2)})`;
        ctx.fillRect(0, 0, W, H);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (audioEl) audioEl.pause();
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
      // 사용자가 직접 첨부한 File이면 원래 이름/타입을 유지하고, AI 슬라이드쇼로 만든 Blob이면 webm으로 저장해요.
      const isUserFile = videoBlob instanceof File;
      const file = isUserFile
        ? videoBlob
        : new File([videoBlob], `ai_video_${Date.now()}.webm`, { type: "video/webm" });
      const uploaded = await Drive.uploadDocument(dataFolderId, file);
      item.videoFileId = uploaded.id;
      item.videoLink = uploaded.webViewLink || "";
    }
    await saveModule("sns", data);
    // 콘텐츠 스튜디오 페이지에서 부르는 경우엔 화면을 다시 그리지 않아요 — 편집 중인 폼/콘티가
    // 통째로 사라지지 않도록, 목록 화면(콘텐츠 운영)일 때만 다시 그려서 최신 상태를 보여줘요.
    if (currentTab === "sns" && snsSubTab !== "studio") refreshCurrentTab();
  } catch (e) {
    console.error("AI 콘텐츠 미디어 첨부 실패", e);
  }
}
