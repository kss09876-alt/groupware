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

// 게시물 스튜디오(캐러셀/카드뉴스형 일반 게시물 전용) 상태 — 릴스(쇼츠)와는 별도로 관리해요.
// slides[0]은 항상 표지(로고 on/off + 하단 타이틀), 나머지는 콘텐츠 슬라이드(하단 좌측 제목+부제)예요.
let postSlides = [];
let postActiveSlideIdx = 0;
let postActiveTab = "text"; // "text" | "image" | "logo" — 오른쪽 설정 패널에서 지금 열려있는 탭 (텍스트를 먼저 입력하는 흐름이라 기본값은 텍스트)

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
    autoFetchDailyIssuesIfStale();
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
      autoFetchDailyIssuesIfStale();
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
  get shortsDraft() {
    return shortsDraft;
  },
  load: loadModule,
};

// ---------------- 탭 전환 ----------------
const TAB_TITLES = {
  dashboard: "대시보드",
  issues: "오늘의 이슈",
  corp: "법인정보",
  notice: "공지사항",
  calendar: "일정/캘린더",
  approval: "전자결재",
  attendance: "근태관리",
  sns: "SNS 운영",
  shorts: "쇼츠 스튜디오",
  postStudio: "게시물 스튜디오",
};

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    // 쇼츠/게시물 스튜디오는 일반 탭과 달리, 들어가는 순간 "작성중" 초안을 바로 만들어서
    // 실시간으로 저장되기 시작해야 하니 별도 진입 함수를 써요.
    if (btn.dataset.tab === "shorts") {
      enterShortsStudio();
    } else if (btn.dataset.tab === "postStudio") {
      enterPostStudio();
    } else {
      goTab(btn.dataset.tab);
    }
    closeMobileSidebar();
  });
});

async function goTab(tab) {
  if (tab !== "shorts") shortsDraft = null; // 쇼츠 스튜디오를 벗어나면 로컬 임시저장 상태를 비워요.
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

  if (tab === "issues") {
    $("#fetchIssuesBtn")?.addEventListener("click", fetchDailyIssues);
    autoFetchDailyIssuesIfStale();
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
        const id = b.dataset.snsContinue;
        const item = cache.sns?.items.find((s) => s.id === id);
        if (item && item.contentType === "post") {
          continuePostDraft(id);
        } else {
          studioDraftId = id;
          snsSubTab = "studio";
          refreshCurrentTab();
        }
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
    // ---- 콘텐츠 운영 목록 체크박스 전체선택/선택삭제 ----
    $$("[data-sns-check]").forEach((chk) => chk.addEventListener("click", (e) => e.stopPropagation()));
    $("#snsSelectAllChk")?.addEventListener("change", (e) => {
      $$("[data-sns-check]").forEach((chk) => (chk.checked = e.target.checked));
    });
    $("#snsBulkDeleteBtn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ids = $$("[data-sns-check]")
        .filter((chk) => chk.checked)
        .map((chk) => chk.dataset.snsCheck);
      if (!ids.length) {
        alert("삭제할 항목을 먼저 선택해주세요.");
        return;
      }
      if (!confirm(`선택한 ${ids.length}개 항목을 삭제할까요? 되돌릴 수 없어요.`)) return;
      const data = await loadModule("sns");
      for (const id of ids) {
        const target = data.items.find((s) => s.id === id);
        if (target?.calendarEventId) await removeSnsCalendarEvent(target.calendarEventId);
      }
      data.items = data.items.filter((s) => !ids.includes(s.id));
      await saveModule("sns", data);
      refreshCurrentTab();
    });

    $$("[data-sns-subtab]").forEach((b) =>
      b.addEventListener("click", () => {
        snsSubTab = b.dataset.snsSubtab;
        refreshCurrentTab();
      })
    );

    // ---- 오늘의 추천 ----
    // 아이디어를 고르면 팝업/자동생성 없이, 그 내용을 가지고 바로 쇼츠 스튜디오나 게시물
    // 스튜디오로 이동해서 거기서 직접 만들 수 있게 해요.
    $("#fetchTrendsBtn")?.addEventListener("click", fetchDailyTrends);
    $$("[data-use-trend-shorts]").forEach((b) =>
      b.addEventListener("click", async () => {
        const data = await loadModule("sns");
        const t = (data.dailyTrends.items || [])[Number(b.dataset.useTrendShorts)];
        if (t) useTrendInShortsStudio(t);
      })
    );
    $$("[data-use-trend-post]").forEach((b) =>
      b.addEventListener("click", async () => {
        const data = await loadModule("sns");
        const t = (data.dailyTrends.items || [])[Number(b.dataset.useTrendPost)];
        if (t) useTrendInPostStudio(t);
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
  if (status === "반려" && item.calendarEventId) {
    await removeSnsCalendarEvent(item.calendarEventId);
    item.calendarEventId = null;
  }
  await saveModule("sns", data);
  refreshCurrentTab();
}

// 콘텐츠를 삭제하거나 반려할 때, 혹시 남아있는 캘린더 일정을 같이 정리해요.
async function removeSnsCalendarEvent(eventId) {
  const cal = await loadModule("calendar");
  cal.items = cal.items.filter((e) => e.id !== eventId);
  await saveModule("calendar", cal);
}

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

// ---------------- 오늘의 이슈 (데일리 뉴스 + 날씨) ----------------
// 뉴스: 네이버 뉴스 검색 API(한국 뉴스에 특화, 무료), 날씨: OpenWeatherMap(무료 티어) —
// 둘 다 Cloudflare Worker(/daily-news, /daily-weather)를 통해 키를 숨긴 채 호출해요.
// 일반 시사(정치/사회/국제) 대신, 콘텐츠 스타트업인 우리 회사에 실제로 도움이 될 만한
// 3가지 주제로 고정해서 매일 하루 한 번, 사람이 버튼을 누르지 않아도 로그인 시/탭 진입 시
// 조용히 새로 받아와요. (날짜가 바뀌면 갱신)
//   1) 지원사업: 우리 회사 사업목적(법인정보) + 정부 지원사업/창업지원금
//   2) SNS·콘텐츠 마케팅 트렌드
//   3) AI 콘텐츠 제작 기술
function issueSupportQuery(corp) {
  const businessContext = corp && corp.registeredPurposes && corp.registeredPurposes.length ? corp.registeredPurposes.join(" ") : corp && corp.name ? corp.name : "콘텐츠 스타트업";
  return businessContext + " 지원사업 창업지원금";
}

// 주제별로 나눠서 여러 번 검색한 뒤 링크 기준으로 중복 제거해 합쳐요.
async function fetchIssueNewsBundle(customKeywords) {
  const corp = await loadModule("corp");
  const queries = [
    { category: "지원사업", q: issueSupportQuery(corp) },
    { category: "SNS·콘텐츠 트렌드", q: "SNS 콘텐츠 마케팅 트렌드" },
    { category: "AI 콘텐츠 기술", q: "AI 콘텐츠 제작 기술" },
  ];
  if (customKeywords) queries.push({ category: "관심 키워드", q: customKeywords });

  let firstError = "";
  const lists = await Promise.all(
    queries.map(async ({ category, q }) => {
      try {
        const res = await fetch(CONFIG.AI_WORKER_URL + "/daily-news", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, display: 5 }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.error) {
          if (!firstError) firstError = (data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")";
          return [];
        }
        return (data.items || []).map((it) => ({ ...it, category }));
      } catch (e) {
        if (!firstError) firstError = e.message || "네트워크 오류";
        return [];
      }
    })
  );
  const seen = new Set();
  const news = [];
  for (const list of lists) {
    for (const item of list) {
      if (!item.link || seen.has(item.link)) continue;
      seen.add(item.link);
      news.push(item);
    }
  }
  return { news, error: news.length ? "" : firstError };
}

async function fetchIssueWeather(city) {
  if (!city) return null;
  try {
    const res = await fetch(CONFIG.AI_WORKER_URL + "/daily-weather", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && !data.error) return data;
  } catch (e) {
    // 날씨는 부가 정보라, 실패해도 뉴스는 그대로 보여줘요.
  }
  return null;
}

// 버튼을 눌러 수동으로 새로고침할 때 (관심 키워드/도시 입력값 반영)
async function fetchDailyIssues() {
  const btn = $("#fetchIssuesBtn");
  const statusEl = $("#issuesStatus");
  const keywords = $("#issuesKeywords")?.value.trim() || "";
  const city = $("#issuesCity")?.value.trim() || "";
  if (!CONFIG.AI_WORKER_URL) {
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "가져오는 중...";
  try {
    const { news, error: newsError } = await fetchIssueNewsBundle(keywords);
    const weather = await fetchIssueWeather(city);
    const data = await loadModule("issues", true);
    data.keywords = keywords;
    data.city = city;
    data.date = todayStr();
    data.news = news;
    data.newsError = newsError || "";
    data.weather = weather;
    await saveModule("issues", data);
    refreshCurrentTab();
  } catch (e) {
    alert("오늘의 이슈를 가져오는 데 실패했어요: " + e.message);
  } finally {
    if (statusEl) statusEl.textContent = "";
    if (btn) btn.disabled = false;
  }
}

// 로그인 직후/대시보드·오늘의 이슈 탭 진입 시 자동으로 호출돼요. 오늘 날짜로 이미
// 받아둔 데이터가 있으면 그냥 넘어가고, 날짜가 바뀌었을 때만 조용히 새로 받아와요.
// (관심 키워드를 입력하지 않아도 정치/사회/국제 + 우리 회사 맞춤 뉴스는 항상 자동으로 채워져요.)
async function autoFetchDailyIssuesIfStale() {
  if (!CONFIG.AI_WORKER_URL) return;
  try {
    const cached = await loadModule("issues");
    if (cached.date === todayStr()) return;
    const { news, error: newsError } = await fetchIssueNewsBundle(cached.keywords || "");
    const weather = await fetchIssueWeather(cached.city || "");
    const fresh = await loadModule("issues", true);
    fresh.date = todayStr();
    fresh.news = news;
    fresh.newsError = newsError || "";
    fresh.weather = weather;
    await saveModule("issues", fresh);
    if (currentTab === "issues" || currentTab === "dashboard") refreshCurrentTab();
  } catch (e) {
    console.error("오늘의 이슈 자동 업데이트 실패:", e);
  }
}

// 추천 카드에서 "쇼츠/게시물 스튜디오에서 만들기"를 누르면, 자동으로 문구·이미지를 만들어
// 팝업으로 던져주는 대신 그 아이디어(주제/후킹 문구)를 가지고 해당 스튜디오로 바로 이동해서
// 직접 만들 수 있게 해요.
async function useTrendInShortsStudio(trend) {
  await enterShortsStudio({
    topic: trend.hook ? `${trend.title} — ${trend.hook}` : trend.title,
    script: trend.reason || "",
    platform: trend.platform || "인스타그램",
  });
}

async function useTrendInPostStudio(trend) {
  await enterPostStudio({
    topic: trend.hook ? `${trend.title} — ${trend.hook}` : trend.title,
    heading: trend.title,
    platform: trend.platform || "인스타그램",
  });
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
// 자동으로(디바운스해서) 계속 저장돼요. 언제든 나갔다가 "이어서 작성"으로 돌아올 수 있어요.
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
// ---------------- 쇼츠 스튜디오 임시 저장(로컬) ----------------
// 쇼츠 스튜디오는 "검토요청으로 등록"을 누르기 전까지 드라이브에 아무것도 쓰지 않아요.
// 대신 입력 내용(주제/스크립트/장면별 나레이션·이미지)을 이 브라우저의 localStorage에
// 임시로 저장해서, 새로고침하거나 다른 탭에 갔다 와도 그대로 남아있게 해요.
const SHORTS_DRAFT_KEY = "gw_shortsDraft";
let shortsDraft = null;
let shortsSaveTimer = null;

function loadShortsDraftFromLocal() {
  try {
    const raw = localStorage.getItem(SHORTS_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

function scheduleShortsLocalSave() {
  if (!shortsDraft) return;
  clearTimeout(shortsSaveTimer);
  shortsSaveTimer = setTimeout(saveShortsDraftToLocal, 500);
}

function saveShortsDraftToLocal() {
  if (!shortsDraft) return;
  shortsDraft.scenes = storyboardScenes;
  try {
    localStorage.setItem(SHORTS_DRAFT_KEY, JSON.stringify(shortsDraft));
  } catch (e) {
    // 용량 초과 등으로 실패하면, 이미지 데이터 없이(문구만) 다시 시도해요.
    try {
      const lite = { ...shortsDraft, scenes: storyboardScenes.map((s) => ({ ...s, mediaDataUrl: null })) };
      localStorage.setItem(SHORTS_DRAFT_KEY, JSON.stringify(lite));
    } catch (e2) {
      console.error("쇼츠 임시 저장 실패", e2);
    }
  }
}

function clearShortsDraftLocal() {
  localStorage.removeItem(SHORTS_DRAFT_KEY);
}

function syncShortsDraftFieldsFromDom() {
  if (!shortsDraft) shortsDraft = { platform: "인스타그램", scenes: [] };
  shortsDraft.topic = $("#ai_topic")?.value || "";
  shortsDraft.tone = $("#ai_tone")?.value || shortsDraft.tone || "교육형";
  shortsDraft.script = $("#ai_script")?.value || "";
  shortsDraft.sceneCount = Number($("#ai_sceneCount")?.value) || shortsDraft.sceneCount || 5;
  shortsDraft.approver = $("#ai_approver")?.value || shortsDraft.approver || "";
  shortsDraft.scenes = storyboardScenes;
}

async function enterShortsStudio(prefill) {
  shortsDraft = loadShortsDraftFromLocal() || {
    platform: "인스타그램",
    topic: "",
    tone: "교육형",
    script: "",
    sceneCount: 5,
    approver: "",
    scenes: [],
  };
  if (prefill) {
    if (prefill.topic) shortsDraft.topic = prefill.topic;
    if (prefill.script) shortsDraft.script = prefill.script;
    if (prefill.platform) shortsDraft.platform = prefill.platform;
  }
  storyboardScenes = Array.isArray(shortsDraft.scenes) ? shortsDraft.scenes : [];
  studioDraftId = null;
  currentTab = "shorts";
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === "shorts"));
  $("#pageTitle").textContent = TAB_TITLES.shorts;
  $("#content").innerHTML = `<div class="loading">불러오는 중...</div>`;
  const html = await Modules.shorts(ctx);
  $("#content").innerHTML = html;
  wireShortsStudio();
  if (storyboardScenes.length) {
    renderStoryboard();
    goShortsStep(2);
  }
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
  onStoryboardReadyHook = () => {
    goShortsStep(2);
    scheduleShortsLocalSave();
  };
  $("#genStoryboardBtn")?.addEventListener("click", generateStoryboard);
  $("#fillAllScenesBtn")?.addEventListener("click", fillAllScenesWithAiImages);
  $$("[data-shorts-back]").forEach((b) =>
    b.addEventListener("click", () => goShortsStep(Number(b.dataset.shortsBack)))
  );
  $("#shortsToStep3Btn")?.addEventListener("click", () => {
    if (!storyboardScenes.length) {
      alert("먼저 콘티를 만들고 장면 이미지를 골라주세요.");
      return;
    }
    const missing = storyboardScenes.filter((s) => !s.mediaDataUrl);
    if (missing.length) {
      alert(`아직 이미지를 고르지 않은 장면이 ${missing.length}개 있어요.`);
      return;
    }
    goShortsStep(3);
    renderShortsFinalList();
  });
  ["ai_topic", "ai_tone", "ai_script", "ai_sceneCount"].forEach((id) => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      syncShortsDraftFieldsFromDom();
      scheduleShortsLocalSave();
    });
  });
  $("#ai_approver")?.addEventListener("input", () => {
    syncShortsDraftFieldsFromDom();
    scheduleShortsLocalSave();
  });
  $("#shortsDownloadAllBtn")?.addEventListener("click", downloadShortsSet);
  $("#shortsSubmitBtn")?.addEventListener("click", submitShortsDraft);
}

// 장면별 나레이션/이미지를 순서대로 정리해서 보여줘요 (자막 합성 없이, 원본 이미지 그대로).
function renderShortsFinalList() {
  const el = $("#shortsFinalList");
  if (!el) return;
  el.innerHTML = storyboardScenes
    .map(
      (s, i) => `
    <div class="storyboard-scene">
      <div class="storyboard-scene-head">#${s.sceneNumber || i + 1}</div>
      ${s.mediaDataUrl ? `<img src="${s.mediaDataUrl}" style="max-width:220px; border-radius:8px;">` : `<div class="post-canvas-empty">이미지 없음</div>`}
      <p style="font-size:13px; margin:8px 0;"><b>나레이션</b><br>${escHtml(s.narration || "")}</p>
      <p class="muted" style="font-size:12px;">화면 자막(참고용): ${escHtml(s.titleText || "")}</p>
    </div>`
    )
    .join("");
}

function downloadFile(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// 대본(나레이션+화면자막 참고문구)을 텍스트 파일로, 장면 이미지들을 각각 파일로 다운로드해요.
// (프리미어 등에서 편집할 때 그대로 가져다 쓸 수 있게 정리된 형태예요.)
async function downloadShortsSet() {
  const statusEl = $("#shortsDownloadStatus");
  if (!storyboardScenes.length) {
    alert("먼저 콘티를 만들어주세요.");
    return;
  }
  if (statusEl) statusEl.textContent = "다운로드 준비 중...";
  const scriptText = storyboardScenes
    .map((s, i) => `#${s.sceneNumber || i + 1}\n나레이션: ${s.narration || ""}\n화면 자막(참고용): ${s.titleText || ""}`)
    .join("\n\n");
  const scriptUrl = URL.createObjectURL(new Blob([scriptText], { type: "text/plain;charset=utf-8" }));
  downloadFile(scriptUrl, "쇼츠_대본.txt");
  for (let i = 0; i < storyboardScenes.length; i++) {
    const s = storyboardScenes[i];
    if (!s.mediaDataUrl) continue;
    downloadFile(s.mediaDataUrl, `장면_${s.sceneNumber || i + 1}.png`);
    // 브라우저가 짧은 시간에 여러 파일을 한꺼번에 다운로드하는 걸 막지 않도록 살짝 간격을 둬요.
    await new Promise((r) => setTimeout(r, 350));
  }
  if (statusEl) statusEl.textContent = "다운로드 완료!";
}

// "검토요청으로 등록"을 눌렀을 때만 실제로 드라이브에 저장되고 SNS 운영 목록에 나타나요.
async function submitShortsDraft() {
  if (!storyboardScenes.length) {
    alert("먼저 콘티를 만들어주세요.");
    return;
  }
  const missing = storyboardScenes.filter((s) => !s.mediaDataUrl);
  if (missing.length) {
    alert(`아직 이미지를 고르지 않은 장면이 ${missing.length}개 있어요.`);
    return;
  }
  syncShortsDraftFieldsFromDom();
  const approver = $("#ai_approver")?.value.trim();
  if (!approver) {
    alert("승인자 이메일을 입력해주세요.");
    return;
  }
  const submitBtn = $("#shortsSubmitBtn");
  const statusEl = $("#shortsSubmitStatus");
  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) statusEl.textContent = "드라이브에 저장 중...";
  try {
    const links = [];
    const fileIds = [];
    for (let i = 0; i < storyboardScenes.length; i++) {
      const s = storyboardScenes[i];
      const blob = await (await fetch(s.mediaDataUrl)).blob();
      const file = new File([blob], `scene_${s.sceneNumber || i + 1}.png`, { type: blob.type || "image/png" });
      const uploaded = await Drive.uploadDocument(dataFolderId, file);
      links.push(uploaded.webViewLink || "");
      fileIds.push(uploaded.id);
    }
    const scriptText = storyboardScenes
      .map((s, i) => `#${s.sceneNumber || i + 1}\n나레이션: ${s.narration || ""}\n화면 자막(참고용): ${s.titleText || ""}`)
      .join("\n\n");
    const data = await loadModule("sns", true);
    const newItem = {
      id: uid(),
      platform: shortsDraft.platform || "인스타그램",
      title: shortsDraft.topic || "(제목없음)",
      content: scriptText,
      hashtags: "",
      topic: shortsDraft.topic || "",
      tone: shortsDraft.tone || "",
      imagePrompt: "",
      script: shortsDraft.script || "",
      assignee: "",
      date: todayStr(),
      time: "09:00",
      scheduledAt: `${todayStr()}T09:00`,
      calendarEventId: null,
      approver,
      status: "검토중",
      contentType: "shorts",
      imageLinks: links,
      imageFileIds: fileIds,
      imageLink: links[0] || "",
      imageFileId: fileIds[0] || "",
      createdAt: nowStr(),
    };
    data.items.push(newItem);
    await saveModule("sns", data);
    clearShortsDraftLocal();
    shortsDraft = null;
    storyboardScenes = [];
    onStoryboardReadyHook = null;
    snsSubTab = "content";
    goTab("sns");
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    if (submitBtn) submitBtn.disabled = false;
    alert("등록에 실패했어요: " + e.message);
  }
}

function wireContentStudio() {
  aiGalleryImages = [];
  aiSelectedImageDataUrl = null;
  aiVideoBlob = null;
  aiNarrationBlob = null;
  storyboardScenes = [];
  shortsDraft = null; // 쇼츠 스튜디오의 로컬 임시저장 상태가 콘텐츠 스튜디오 편집에 섞여 들어가지 않게 해요.
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

  ["ai_platform", "ai_title", "ai_assignee", "ai_date", "ai_time", "ai_approver", "ai_topic", "ai_tone", "ai_imgPrompt", "ai_script", "ai_caption"].forEach(
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
  $("#fillAllScenesBtn")?.addEventListener("click", fillAllScenesWithAiImages);
  $("#assembleSetBtn")?.addEventListener("click", assembleContentSet);
  $("#ai_imageFile")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    aiGalleryImages = [dataUrl, ...aiGalleryImages];
    aiSelectedImageDataUrl = dataUrl;
    renderAiGallery();
    const statusEl = $("#aiLocalMediaStatus");
    if (statusEl) statusEl.textContent = `사진 첨부됨: ${file.name}`;
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
    if (statusEl) statusEl.textContent = (statusEl.textContent ? statusEl.textContent + " · " : "") + `영상 첨부됨: ${file.name}`;
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
    btn.textContent = "문구 생성";
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

// 사진 위에 "지금 99%가 모르는..." 스타일의 카드뉴스 자막을 합성해요.
// opts로 위치(상단/중앙/하단)·글자색·배경색·자간까지 세부 조절할 수 있어요.
// (구버전 호출 호환: composeTitleOverlay(url, title, 48, "#fff") 형태도 계속 지원해요.)
function defaultTitleStyle() {
  return { fontSize: 48, color: "#ffffff", bgColor: "#0b0b0b", position: "top", letterSpacing: 0 };
}

async function composeTitleOverlay(imageDataUrl, titleText, opts, legacyColor) {
  const o = typeof opts === "object" && opts !== null ? opts : { fontSize: opts, color: legacyColor };
  const img = await loadImageEl(imageDataUrl);
  const W = 720,
    H = 900;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const fontSize = Math.max(20, Number(o.fontSize) || 48);
  const textColor = o.color || "#ffffff";
  const bgColor = o.bgColor || "#0b0b0b";
  const position = o.position || "top"; // "top" | "middle" | "bottom"
  const letterSpacing = Number(o.letterSpacing) || 0;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${letterSpacing}px`;

  ctx.font = `bold ${fontSize}px sans-serif`;
  const maxTextWidth = W - 60;
  const lineHeight = fontSize * 1.25;
  const lines = wrapTextLines(ctx, (titleText || "").trim() || "제목", maxTextWidth, 3);
  const bandPadding = 36;
  const bandHeight = Math.min(H * 0.6, Math.max(140, lines.length * lineHeight + bandPadding * 2));

  // 사진은 항상 전체 캔버스를 채우도록 먼저 그려요.
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale,
    dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

  let bandY;
  if (position === "bottom") bandY = H - bandHeight;
  else if (position === "middle") bandY = (H - bandHeight) / 2;
  else bandY = 0; // top

  // 중앙/하단 배치는 사진이 이미 다 보이므로 띠에 살짝 투명도를 줘서 카드뉴스 느낌은 유지하되 사진도 함께 보이게 해요.
  ctx.fillStyle = bgColor;
  ctx.globalAlpha = position === "top" ? 1 : 0.78;
  ctx.fillRect(0, bandY, W, bandHeight);
  ctx.globalAlpha = 1;

  ctx.fillStyle = textColor;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const startY = bandY + (bandHeight - lines.length * lineHeight) / 2 + fontSize * 0.85;
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
    const composed = await composeTitleOverlay(aiSelectedImageDataUrl, title, { fontSize, color });
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

// ============================================================
// 게시물 스튜디오 — 여러 장을 넘겨보는 "캐러셀형" 일반 게시물 전용 (릴스/쇼츠와는 완전히 별도 흐름)
// slides[0]은 표지(로고 on/off + 하단 타이틀), 나머지는 콘텐츠 슬라이드(하단 좌측 제목+부제)예요.
// ============================================================

function newCoverSlide() {
  return {
    kind: "cover",
    rawImage: null,
    composedDataUrl: null,
    logoDataUrl: null,
    logoEnabled: false,
    logoPosition: "top-left",
    heading: "",
    subheading: "",
    fontSize: 40,
    headingColor: "#ffffff",
    subColor: "#ffffff",
  };
}

function newContentSlide(n) {
  return {
    kind: "content",
    rawImage: null,
    composedDataUrl: null,
    heading: `슬라이드 ${n}`,
    subheading: "",
    fontSize: 34,
    headingColor: "#ffffff",
    subColor: "#ffffff",
  };
}

// 사진 전체를 꽉 채우고, 하단에 가독성용 그라디언트 + (표지면) 로고 + 좌측 하단 제목/부제를 얹어요.
// composeTitleOverlay(카드뉴스용 상단/중앙/하단 띠)와는 다른, "코너 캡션" 스타일이에요.
async function composePostSlide(imageDataUrl, opts) {
  const img = await loadImageEl(imageDataUrl);
  const W = 720,
    H = 900;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale,
    dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

  // 어떤 사진이 와도 텍스트가 잘 읽히도록 하단에 자연스러운 그라디언트를 깔아요.
  const grad = ctx.createLinearGradient(0, H * 0.4, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.8)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, H * 0.4, W, H * 0.6);

  if (opts.logoEnabled && opts.logoDataUrl) {
    try {
      const logoImg = await loadImageEl(opts.logoDataUrl);
      const maxLogoW = 100;
      const lscale = Math.min(1, maxLogoW / logoImg.width);
      const lw = logoImg.width * lscale,
        lh = logoImg.height * lscale;
      const pad = 24;
      let lx = pad;
      if (opts.logoPosition === "top-center") lx = (W - lw) / 2;
      else if (opts.logoPosition === "top-right") lx = W - lw - pad;
      ctx.drawImage(logoImg, lx, pad, lw, lh);
    } catch (e) {
      // 로고 로드 실패는 조용히 무시해요.
    }
  }

  const headingSize = Math.max(20, Number(opts.fontSize) || 40);
  const subSize = Math.max(14, Math.round(headingSize * 0.55));
  const maxW = W - 72;
  const makeLines = (text, size, bold, color) => {
    ctx.font = `${bold ? "bold " : ""}${size}px sans-serif`;
    return wrapTextLines(ctx, text, maxW, 2).map((t) => ({ text: t, size, bold, color, lineHeight: size * 1.25 }));
  };
  const headingLines = (opts.heading || "").trim() ? makeLines(opts.heading, headingSize, true, opts.headingColor || "#ffffff") : [];
  const subLines = (opts.subheading || "").trim() ? makeLines(opts.subheading, subSize, false, opts.subColor || "#ffffff") : [];
  const allLines = [...headingLines, ...subLines];
  if (allLines.length) {
    const totalH = allLines.reduce((a, l) => a + l.lineHeight, 0);
    const startTop = H - 36 - totalH;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 6;
    let cum = 0;
    allLines.forEach((l) => {
      ctx.font = `${l.bold ? "bold " : ""}${l.size}px sans-serif`;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, 36, startTop + cum + l.lineHeight * 0.8);
      cum += l.lineHeight;
    });
    ctx.shadowBlur = 0;
  }

  return canvas.toDataURL("image/png");
}

function activePostSlide() {
  return postSlides[postActiveSlideIdx] || postSlides[0];
}

function renderPostSlideList() {
  const el = $("#postSlideList");
  if (!el) return;
  el.innerHTML =
    postSlides
      .map(
        (s, i) => `
    <div class="post-slide-thumb ${i === postActiveSlideIdx ? "active" : ""}" data-post-slide="${i}">
      ${s.composedDataUrl ? `<img src="${s.composedDataUrl}">` : `<div class="post-slide-thumb-empty">${i === 0 ? "표지" : "슬라이드 " + (i + 1)}<br>이미지 없음</div>`}
      <span class="post-slide-thumb-label">${i === 0 ? "표지" : "#" + (i + 1)}</span>
      ${i > 0 ? `<button class="post-slide-remove" data-post-remove="${i}" title="삭제">✕</button>` : ""}
    </div>`
      )
      .join("") + `<button class="post-add-slide-btn" id="postAddSlideBtn">+ 슬라이드<br>추가</button>`;
  $$("[data-post-slide]", el).forEach((t) =>
    t.addEventListener("click", () => {
      postActiveSlideIdx = Number(t.dataset.postSlide);
      if (postActiveTab === "logo" && activePostSlide().kind !== "cover") postActiveTab = "image";
      renderPostSlideList();
      renderPostCanvasStage();
      renderPostTabPanel();
    })
  );
  $$("[data-post-remove]", el).forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.postRemove);
      postSlides.splice(i, 1);
      if (postActiveSlideIdx >= postSlides.length) postActiveSlideIdx = postSlides.length - 1;
      renderPostSlideList();
      renderPostCanvasStage();
      renderPostTabPanel();
    })
  );
  $("#postAddSlideBtn")?.addEventListener("click", postAddSlide);
}

function postAddSlide() {
  postSlides.push(newContentSlide(postSlides.length));
  postActiveSlideIdx = postSlides.length - 1;
  postActiveTab = "text";
  renderPostSlideList();
  renderPostCanvasStage();
  renderPostTabPanel();
}

function renderPostCanvasStage() {
  const el = $("#postCanvasStage");
  if (!el) return;
  const s = activePostSlide();
  const arrows =
    postSlides.length > 1
      ? `
    <button class="post-carousel-arrow prev" id="postPrevBtn">‹</button>
    <button class="post-carousel-arrow next" id="postNextBtn">›</button>
    <div class="post-carousel-dots">${postSlides.map((_, i) => `<span class="${i === postActiveSlideIdx ? "active" : ""}"></span>`).join("")}</div>`
      : "";
  el.innerHTML =
    (s && s.composedDataUrl ? `<img src="${s.composedDataUrl}">` : `<div class="post-canvas-empty">오른쪽 "이미지" 탭에서 사진을 골라주세요</div>`) + arrows;
  const nav = (dir) => {
    postActiveSlideIdx = (postActiveSlideIdx + dir + postSlides.length) % postSlides.length;
    if (postActiveTab === "logo" && activePostSlide().kind !== "cover") postActiveTab = "image";
    renderPostSlideList();
    renderPostCanvasStage();
    renderPostTabPanel();
  };
  $("#postPrevBtn")?.addEventListener("click", () => nav(-1));
  $("#postNextBtn")?.addEventListener("click", () => nav(1));
}

function renderPostTabPanel() {
  const tabsEl = $("#postTabs");
  const panelEl = $("#postTabPanel");
  if (!tabsEl || !panelEl) return;
  const s = activePostSlide();
  if (postActiveTab === "logo" && s.kind !== "cover") postActiveTab = "image";
  $$(".post-tab-btn", tabsEl).forEach((b) => {
    const tab = b.dataset.postTab;
    if (tab === "logo") b.style.display = s.kind === "cover" ? "" : "none";
    b.classList.toggle("active", tab === postActiveTab);
  });

  if (postActiveTab === "text") {
    panelEl.innerHTML = `
      <label style="display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--muted); font-weight:600;">
        ${s.kind === "cover" ? "타이틀" : "제목"}
        <input id="postHeadingInput" value="${escHtml(s.heading || "")}">
      </label>
      <label style="display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--muted); font-weight:600; margin-top:8px;">
        ${s.kind === "cover" ? "부제(선택)" : "부제/설명"}
        <input id="postSubInput" value="${escHtml(s.subheading || "")}">
      </label>
      <div class="scene-style-row" style="margin-top:10px;">
        <label>크기 <input type="range" min="20" max="72" id="postFontSizeInput" value="${Number(s.fontSize) || 40}"></label>
        <label>제목색 <input type="color" id="postHeadColorInput" value="${s.headingColor || "#ffffff"}"></label>
        <label>부제색 <input type="color" id="postSubColorInput" value="${s.subColor || "#ffffff"}"></label>
      </div>
    `;
    $("#postHeadingInput")?.addEventListener("input", (e) => {
      s.heading = e.target.value;
      postRecomposeActiveSlide();
    });
    $("#postSubInput")?.addEventListener("input", (e) => {
      s.subheading = e.target.value;
      postRecomposeActiveSlide();
    });
    $("#postFontSizeInput")?.addEventListener("input", (e) => {
      s.fontSize = Number(e.target.value);
      postRecomposeActiveSlide();
    });
    $("#postHeadColorInput")?.addEventListener("input", (e) => {
      s.headingColor = e.target.value;
      postRecomposeActiveSlide();
    });
    $("#postSubColorInput")?.addEventListener("input", (e) => {
      s.subColor = e.target.value;
      postRecomposeActiveSlide();
    });
  } else if (postActiveTab === "logo") {
    panelEl.innerHTML = `
      <label class="checkbox-label"><input type="checkbox" id="postLogoEnabledInput" ${s.logoEnabled ? "checked" : ""}> 표지에 로고 표시</label>
      <div class="modal-actions" style="justify-content:flex-start; margin-top:8px;">
        <label class="btn btn-secondary btn-tiny" style="cursor:pointer;">로고 이미지 업로드<input type="file" accept="image/*" id="postLogoFileInput" style="display:none;"></label>
        <select id="postLogoPosInput" style="font-size:12px; padding:4px 6px; border-radius:6px;">
          <option value="top-left" ${s.logoPosition === "top-left" ? "selected" : ""}>좌상단</option>
          <option value="top-center" ${s.logoPosition === "top-center" ? "selected" : ""}>중앙상단</option>
          <option value="top-right" ${s.logoPosition === "top-right" ? "selected" : ""}>우상단</option>
        </select>
      </div>
      ${
        s.logoDataUrl
          ? `<img src="${s.logoDataUrl}" style="max-width:80px; max-height:60px; margin-top:8px; border-radius:6px; border:1px solid var(--border,#e5e5ea);">`
          : `<p class="hint" style="margin-top:8px;">아직 업로드한 로고가 없어요. 없으면 로고 없이 만들어져요.</p>`
      }
    `;
    $("#postLogoEnabledInput")?.addEventListener("change", (e) => {
      s.logoEnabled = e.target.checked;
      postRecomposeActiveSlide();
    });
    $("#postLogoPosInput")?.addEventListener("change", (e) => {
      s.logoPosition = e.target.value;
      postRecomposeActiveSlide();
    });
    $("#postLogoFileInput")?.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      s.logoDataUrl = await fileToDataUrl(file);
      s.logoEnabled = true;
      await postRecomposeActiveSlide();
      renderPostTabPanel();
    });
  } else {
    panelEl.innerHTML = `
      <div class="modal-actions" style="justify-content:flex-start; flex-wrap:wrap;">
        <button class="btn btn-secondary btn-tiny" id="postAiImageBtn">AI 이미지</button>
        <button class="btn btn-secondary btn-tiny" id="postPexelsBtn">Pexels 추천</button>
        <label class="btn btn-secondary btn-tiny" style="cursor:pointer;">업로드<input type="file" accept="image/*" id="postUploadInput" style="display:none;"></label>
      </div>
      <span class="muted" id="postImageStatus"></span>
      <div class="ai-image-gallery" id="postPexelsResults"></div>
    `;
    $("#postAiImageBtn")?.addEventListener("click", postGenerateAiImage);
    $("#postPexelsBtn")?.addEventListener("click", postSearchPexels);
    $("#postUploadInput")?.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      s.rawImage = dataUrl;
      await postRecomposeActiveSlide();
    });
  }
}

let postRecomposeTimer = null;
function postRecomposeActiveSlide() {
  const s = activePostSlide();
  if (!s) return Promise.resolve();
  clearTimeout(postRecomposeTimer);
  return new Promise((resolve) => {
    postRecomposeTimer = setTimeout(async () => {
      if (s.rawImage) {
        try {
          s.composedDataUrl = await composePostSlide(s.rawImage, s);
          schedulePostDriveSync();
        } catch (e) {
          console.error("게시물 슬라이드 합성 실패", e);
        }
      }
      renderPostSlideList();
      renderPostCanvasStage();
      resolve();
    }, 200);
  });
}

// 슬라이드가 완성될 때마다(디바운스해서) 자동으로 드라이브에 저장해요 — 스튜디오에서
// 나가거나 브라우저를 닫아도 만든 이미지가 드라이브에 남아있고, SNS 운영 목록에서 바로
// 보고 다운로드할 수 있어요. 이미 올린 슬라이드는 새로 만들지 않고 같은 파일을 덮어써요.
let postSyncTimer = null;
function schedulePostDriveSync() {
  clearTimeout(postSyncTimer);
  postSyncTimer = setTimeout(postSyncToDrive, 1200);
}

async function postSyncToDrive() {
  if (!studioDraftId || !dataFolderId) return;
  const toSync = postSlides.filter((s) => s.composedDataUrl && s.composedDataUrl !== s._syncedDataUrl);
  if (!toSync.length) return;
  try {
    for (const s of toSync) {
      const blob = await (await fetch(s.composedDataUrl)).blob();
      const file = new File([blob], `post_slide_${Date.now()}.png`, { type: blob.type || "image/png" });
      const uploaded = await Drive.uploadDocument(dataFolderId, file, s.driveFileId || null);
      s.driveFileId = uploaded.id;
      s.driveLink = uploaded.webViewLink || "";
      s._syncedDataUrl = s.composedDataUrl;
    }
    const data = await loadModule("sns", true);
    const item = data.items.find((x) => x.id === studioDraftId);
    if (item) {
      const composed = postSlides.filter((s) => s.driveLink);
      item.imageLinks = composed.map((s) => s.driveLink);
      item.imageFileIds = composed.map((s) => s.driveFileId);
      item.imageLink = item.imageLinks[0] || "";
      item.imageFileId = item.imageFileIds[0] || "";
      item.contentType = "post";
      await saveModule("sns", data);
    }
  } catch (e) {
    console.error("게시물 드라이브 자동 저장 실패", e);
  }
}

let postImageBusy = false;
async function postGenerateAiImage() {
  if (postImageBusy) return;
  postImageBusy = true;
  const statusEl = $("#postImageStatus");
  if (statusEl) statusEl.textContent = "생성 중...";
  try {
    const s = activePostSlide();
    const prompt = s.heading || $("#ai_topic")?.value || "";
    const cacheKey = "ai:" + prompt;
    let dataUrl = aiImageCache.get(cacheKey) || null;
    if (!dataUrl && CONFIG.AI_WORKER_URL) {
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
    aiImageCache.set(cacheKey, dataUrl);
    s.rawImage = dataUrl;
    await postRecomposeActiveSlide();
    if (statusEl) statusEl.textContent = "완료";
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    alert("이미지 생성에 실패했어요: " + e.message);
  } finally {
    postImageBusy = false;
  }
}

async function postSearchPexels() {
  if (postImageBusy) return;
  postImageBusy = true;
  const statusEl = $("#postImageStatus");
  const optionsEl = $("#postPexelsResults");
  const s = activePostSlide();
  const query = s.heading || $("#ai_topic")?.value || "";
  if (!CONFIG.AI_WORKER_URL) {
    postImageBusy = false;
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  if (statusEl) statusEl.textContent = "검색 중...";
  if (optionsEl) optionsEl.innerHTML = "";
  try {
    const cacheKey = "pexels:" + query;
    let items = aiImageCache.get(cacheKey);
    if (!items) {
      const res = await fetch(CONFIG.AI_WORKER_URL + "/search-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, type: "photos", perPage: 6 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.error) {
        throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
      }
      items = data.items || [];
      aiImageCache.set(cacheKey, items);
    }
    if (!items.length) {
      if (statusEl) statusEl.textContent = "검색 결과가 없어요.";
      return;
    }
    if (statusEl) statusEl.textContent = "클릭해서 선택하세요.";
    if (optionsEl) {
      optionsEl.innerHTML = items
        .map((it, j) => `<div class="ai-thumb" data-post-pexels-item="${j}"><img src="${it.thumb}" alt="Pexels 사진"></div>`)
        .join("");
      $$("[data-post-pexels-item]", optionsEl).forEach((elm) =>
        elm.addEventListener("click", async () => {
          const item = items[Number(elm.dataset.postPexelsItem)];
          if (statusEl) statusEl.textContent = "가져오는 중...";
          try {
            const r = await fetch(item.imageUrl);
            const blob = await r.blob();
            const dataUrl = await fileToDataUrl(blob);
            s.rawImage = dataUrl;
            await postRecomposeActiveSlide();
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
  } finally {
    postImageBusy = false;
  }
}

async function enterPostStudio(prefill) {
  shortsDraft = null;
  const data = await loadModule("sns");
  const item = {
    id: uid(),
    platform: (prefill && prefill.platform) || "인스타그램",
    title: (prefill && prefill.topic) || "(제목없음)",
    content: "",
    hashtags: "",
    topic: (prefill && prefill.topic) || "",
    tone: "",
    imagePrompt: "",
    script: "",
    assignee: "",
    date: todayStr(),
    time: "09:00",
    scheduledAt: `${todayStr()}T09:00`,
    calendarEventId: null,
    approver: "",
    status: "작성중",
    contentType: "post",
    createdAt: nowStr(),
  };
  data.items.push(item);
  await saveModule("sns", data);
  studioDraftId = item.id;
  postSlides = [newCoverSlide()];
  if (prefill && prefill.heading) postSlides[0].heading = prefill.heading;
  postActiveSlideIdx = 0;
  postActiveTab = "text";
  currentTab = "postStudio";
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === "postStudio"));
  $("#pageTitle").textContent = TAB_TITLES.postStudio;
  $("#content").innerHTML = `<div class="loading">불러오는 중...</div>`;
  const html = await Modules.postStudio(ctx);
  $("#content").innerHTML = html;
  wirePostStudio();
}

async function continuePostDraft(id) {
  shortsDraft = null;
  studioDraftId = id;
  postSlides = [newCoverSlide()];
  postActiveSlideIdx = 0;
  postActiveTab = "text";
  currentTab = "postStudio";
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === "postStudio"));
  $("#pageTitle").textContent = TAB_TITLES.postStudio;
  $("#content").innerHTML = `<div class="loading">불러오는 중...</div>`;
  const html = await Modules.postStudio(ctx);
  $("#content").innerHTML = html;
  wirePostStudio();
}

function wirePostStudio() {
  renderPostSlideList();
  renderPostCanvasStage();
  renderPostTabPanel();
  $$(".post-tab-btn").forEach((b) =>
    b.addEventListener("click", () => {
      postActiveTab = b.dataset.postTab;
      renderPostTabPanel();
    })
  );
  $("#ai_topic")?.addEventListener("input", scheduleStudioAutosave);
  $("#ai_approver")?.addEventListener("input", scheduleStudioAutosave);
  $("#postDownloadBtn")?.addEventListener("click", () => {
    const s = activePostSlide();
    if (!s || !s.composedDataUrl) {
      alert("먼저 이미지를 채워서 슬라이드를 완성해주세요.");
      return;
    }
    const a = document.createElement("a");
    a.href = s.composedDataUrl;
    a.download = `게시물_슬라이드_${postActiveSlideIdx + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  $("#postSubmitBtn")?.addEventListener("click", async () => {
    const missing = postSlides.filter((s) => !s.composedDataUrl);
    if (missing.length) {
      alert(`아직 이미지를 채우지 않은 슬라이드가 ${missing.length}개 있어요.`);
      return;
    }
    if (!$("#ai_approver")?.value.trim()) {
      alert("승인자 이메일을 입력해주세요.");
      return;
    }
    await saveStudioDraftNow();
    const submitBtn = $("#postSubmitBtn");
    const statusEl = $("#postSubmitStatus");
    if (submitBtn) submitBtn.disabled = true;
    if (statusEl) statusEl.textContent = "드라이브에 저장 중...";
    try {
      const draftId = studioDraftId;
      clearTimeout(postSyncTimer);
      await postSyncToDrive(); // 슬라이드는 만들 때마다 이미 자동 저장되지만, 마지막 변경분까지 확실히 반영해요.
      const data2 = await loadModule("sns", true);
      const item2 = data2.items.find((s) => s.id === draftId);
      if (item2) {
        if (item2.title === "(제목없음)" && item2.topic) item2.title = item2.topic;
        item2.status = "검토중";
        await saveModule("sns", data2);
      }
      studioDraftId = null;
      postSlides = [];
      snsSubTab = "content";
      goTab("sns");
    } catch (e) {
      if (statusEl) statusEl.textContent = "";
      if (submitBtn) submitBtn.disabled = false;
      alert("등록에 실패했어요: " + e.message);
    }
  });
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
    storyboardScenes = (data.scenes || []).map((s) => ({
      ...s,
      mediaDataUrl: null,
    }));
    renderStoryboard();
    const row = $("#storyboardAssembleRow");
    if (row) row.style.display = "flex";
    statusEl.textContent = `${storyboardScenes.length}개 장면을 만들었어요. 각 장면마다 이미지를 골라주세요.`;
    if (onStoryboardReadyHook) onStoryboardReadyHook();
    scheduleShortsLocalSave();
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
        화면 자막(참고용 — 합성되지 않아요, 편집할 때 참고해주세요)
        <input data-scene-field="titleText" data-scene-idx="${i}" value="${escHtml(s.titleText)}">
      </label>
      <p class="hint" style="margin:6px 0;">${escHtml(s.imageKeyword)}</p>
      <div class="modal-actions" style="justify-content:flex-start;">
        <button class="btn btn-secondary btn-tiny" data-scene-ai="${i}">AI 이미지</button>
        <button class="btn btn-secondary btn-tiny" data-scene-pexels="${i}">Pexels 추천</button>
        <label class="btn btn-secondary btn-tiny" style="cursor:pointer;">업로드<input type="file" accept="image/*" data-scene-upload="${i}" style="display:none;"></label>
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
      scheduleShortsLocalSave();
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

// 선택된 원본 이미지를 그대로(자막 합성 없이) 그 장면에 첨부하고 미리보기를 갱신해요.
async function sceneSetMedia(i, rawDataUrl) {
  const statusEl = $(`[data-scene-status="${i}"]`);
  if (statusEl) statusEl.textContent = "첨부 중...";
  try {
    storyboardScenes[i].mediaDataUrl = rawDataUrl;
    const previewEl = $(`[data-scene-preview="${i}"]`);
    if (previewEl) previewEl.innerHTML = `<img src="${rawDataUrl}" style="max-width:160px; border-radius:8px; margin-top:6px;">`;
    if (statusEl) statusEl.textContent = "완료";
    scheduleShortsLocalSave();
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    alert("이미지 첨부에 실패했어요: " + e.message);
  }
}

// 같은 장면에서 버튼을 연타해서 생기는 중복 호출(=낭비되는 API 사용량)을 막기 위한 진행중 표시예요.
const sceneBusy = new Set();
// 같은 검색어/프롬프트로 다시 요청하지 않도록 결과를 잠깐 기억해둬요(장면 자막만 바꾸고 다시 눌렀을 때 등).
const aiImageCache = new Map();

async function sceneGenerateAiImage(i) {
  if (sceneBusy.has(i)) return;
  sceneBusy.add(i);
  const statusEl = $(`[data-scene-status="${i}"]`);
  if (statusEl) statusEl.textContent = "생성 중...";
  try {
    const prompt = storyboardScenes[i].imageKeyword || storyboardScenes[i].titleText || "";
    const cacheKey = "ai:" + prompt;
    let dataUrl = aiImageCache.get(cacheKey) || null;
    if (!dataUrl && CONFIG.AI_WORKER_URL) {
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
    aiImageCache.set(cacheKey, dataUrl);
    await sceneSetMedia(i, dataUrl);
  } catch (e) {
    if (statusEl) statusEl.textContent = "";
    alert("장면 이미지 생성에 실패했어요: " + e.message);
  } finally {
    sceneBusy.delete(i);
  }
}

// "각 장면마다 일일이 버튼 누르기"가 번거로우니, 아직 사진이 없는 장면들을 순서대로(=동시에 몰아치지 않고)
// AI 이미지로 한번에 채워주는 일괄 처리예요. 순차 실행이라 무료 API 분당 제한에도 안전해요.
async function fillAllScenesWithAiImages() {
  const btn = $("#fillAllScenesBtn");
  const statusEl = $("#fillAllScenesStatus");
  const targets = storyboardScenes.map((s, i) => i).filter((i) => !storyboardScenes[i].mediaDataUrl);
  if (!targets.length) {
    if (statusEl) statusEl.textContent = "이미 모든 장면에 이미지가 있어요.";
    return;
  }
  if (btn) btn.disabled = true;
  for (let n = 0; n < targets.length; n++) {
    if (statusEl) statusEl.textContent = `장면 채우는 중... (${n + 1}/${targets.length})`;
    await sceneGenerateAiImage(targets[n]);
  }
  if (statusEl) statusEl.textContent = "완료! 마음에 안 드는 장면은 각각 다시 골라도 돼요.";
  if (btn) btn.disabled = false;
}

async function sceneSearchPexels(i) {
  if (sceneBusy.has(i)) return;
  sceneBusy.add(i);
  const statusEl = $(`[data-scene-status="${i}"]`);
  const optionsEl = $(`[data-scene-options="${i}"]`);
  const query = storyboardScenes[i].imageKeyword || storyboardScenes[i].titleText || "";
  if (!CONFIG.AI_WORKER_URL) {
    sceneBusy.delete(i);
    alert("AI Worker 주소가 설정되어 있지 않아요.");
    return;
  }
  if (statusEl) statusEl.textContent = "검색 중...";
  if (optionsEl) optionsEl.innerHTML = "";
  try {
    const cacheKey = "pexels:" + query;
    let items = aiImageCache.get(cacheKey);
    if (!items) {
      const res = await fetch(CONFIG.AI_WORKER_URL + "/search-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, type: "photos", perPage: 6 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.error) {
        throw new Error((data && (data.detail || data.error)) || "서버 오류 (" + res.status + ")");
      }
      items = data.items || [];
      aiImageCache.set(cacheKey, items);
    }
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
  } finally {
    sceneBusy.delete(i);
  }
}

// 모든 장면에 이미지가 준비되면, 그 장면 이미지들로 "일반 게시물용 대표 이미지 + 릴스 영상"을
// 한 세트로 자동 완성해요 (기존 이미지 갤러리/나레이션/슬라이드쇼 로직을 그대로 재사용해요).
// 콘텐츠 스튜디오에 내장된 콘티 기능 전용: 장면 이미지들 중 첫 장면을 대표 이미지로 설정해서
// 드라이브에 저장해요(영상/나레이션 음성은 만들지 않아요 — 필요하면 편집 프로그램에서 별도로 작업해주세요).
async function assembleContentSet() {
  const btn = $("#assembleSetBtn");
  const statusEl = $("#assembleSetStatus");
  if (!storyboardScenes.length) return;
  const missing = storyboardScenes.filter((s) => !s.mediaDataUrl);
  if (missing.length) {
    alert(`아직 이미지를 고르지 않은 장면이 ${missing.length}개 있어요. 모든 장면에 이미지를 먼저 골라주세요.`);
    return;
  }
  btn.disabled = true;
  try {
    statusEl.textContent = "게시물용 대표 이미지 설정 중...";
    aiGalleryImages = storyboardScenes.map((s) => s.mediaDataUrl);
    aiSelectedImageDataUrl = aiGalleryImages[0];
    renderAiGallery();
    syncStudioMedia();
    statusEl.textContent = "완성했어요! 첫 장면 이미지가 대표 이미지로 저장됐어요. 필요하면 위 문구를 다듬고 '검토요청으로 등록'을 눌러주세요.";
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
