// app.js — 로그인/폴더연결 흐름 + 탭 전환 + 각 모듈의 이벤트 처리

let dataFolderId = localStorage.getItem("gw_folderId") || null;
let currentTab = "dashboard";
let corpSubTab = "info"; // 법인정보 탭 내부 하위탭: "info" | "seal"
const cache = {}; // 모듈별 로드된 데이터 캐시 (탭 전환 시 재사용, 저장 후 무효화)

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
window.addEventListener("load", async () => {
  if (!CONFIG.CLIENT_ID.includes(".apps.googleusercontent.com") || CONFIG.CLIENT_ID.startsWith("YOUR_")) {
    $("#setupWarning").style.display = "block";
  }
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
    Drive.requestSignInConsent();
  };
  $("#googleSignInBtn").innerHTML = "";
  $("#googleSignInBtn").appendChild(btn);
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
  } else {
    showScreen("folderScreen");
  }
}

$("#createFolderBtn")?.addEventListener("click", async () => {
  $("#folderStatus").textContent = "폴더를 만드는 중...";
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
  btn.addEventListener("click", () => goTab(btn.dataset.tab));
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

// ---------------- 인감관리: 서류에 도장 이미지 찍기 (pdf-lib 사용) ----------------
// 실제 등기소/공증 효력이 있는 전자서명이 아니라, 사내 서류에 도장 이미지를
// 시각적으로 얹어주는 기능입니다. jpg/png는 먼저 1페이지짜리 PDF로 감싼 뒤 처리합니다.
async function stampAndSaveDocument(file, sealType, pos, pageMode) {
  setSyncStatus("도장 찍는 중...", true);
  try {
    if (typeof PDFLib === "undefined") {
      throw new Error("PDF 처리 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침 해주세요.");
    }
    const { PDFDocument } = PDFLib;
    const c = await loadModule("corp");
    const seal = c.seals && c.seals[sealType];
    if (!seal || !seal.imageDataUrl) throw new Error("등록된 도장이 없어요.");

    const arrayBuf = await file.arrayBuffer();
    const isImage = file.type.startsWith("image/");
    let pdfBytes;
    if (isImage) {
      const doc = await PDFDocument.create();
      const img = file.type.includes("png") ? await doc.embedPng(arrayBuf) : await doc.embedJpg(arrayBuf);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      pdfBytes = await doc.save();
    } else {
      pdfBytes = arrayBuf;
    }

    const pdfDoc = await PDFDocument.load(pdfBytes);
    const sealBytes = await (await fetch(seal.imageDataUrl)).arrayBuffer();
    const sealImg = seal.imageDataUrl.startsWith("data:image/png")
      ? await pdfDoc.embedPng(sealBytes)
      : await pdfDoc.embedJpg(sealBytes);

    const pages = pdfDoc.getPages();
    const targetPages = pageMode === "all" ? pages : pageMode === "first" ? [pages[0]] : [pages[pages.length - 1]];

    const sealHeight = 90;
    const sealWidth = sealHeight * (sealImg.width / sealImg.height);
    const margin = 36;
    targetPages.forEach((page) => {
      const { width, height } = page.getSize();
      let x, y;
      if (pos === "br") { x = width - margin - sealWidth; y = margin; }
      else if (pos === "bl") { x = margin; y = margin; }
      else if (pos === "tr") { x = width - margin - sealWidth; y = height - margin - sealHeight; }
      else { x = margin; y = height - margin - sealHeight; }
      page.drawImage(sealImg, { x, y, width: sealWidth, height: sealHeight, opacity: 0.92 });
    });

    const stampedBytes = await pdfDoc.save();
    const stampedBlob = new Blob([stampedBytes], { type: "application/pdf" });
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const stampedFile = new File([stampedBlob], `${baseName}_날인.pdf`, { type: "application/pdf" });

    const uploaded = await Drive.uploadDocument(dataFolderId, stampedFile, null);

    const c2 = await loadModule("corp");
    c2.sealedDocs = c2.sealedDocs || [];
    c2.sealedDocs.unshift({
      id: uid(),
      name: stampedFile.name,
      sealLabel: seal.label || (sealType === "corporate" ? "법인인감" : "사용인감"),
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
          fiscalYear: $("#f_fiscalYear").value,
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
      openModal(Modules.sealPlaceForm(file.name, c.seals));
      $("#confirmSealBtn").addEventListener("click", async () => {
        const sealType = $("#f_sealType").value;
        const pos = $("#f_sealPos").value;
        const pageMode = $("#f_sealPage").value;
        closeModal();
        await stampAndSaveDocument(file, sealType, pos, pageMode);
        e.target.value = "";
      });
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
        data.items.push({
          id: uid(),
          platform: $("#f_platform").value,
          title: $("#f_title").value || "(제목없음)",
          content: $("#f_content").value,
          assignee: $("#f_assignee").value,
          date: $("#f_date").value || todayStr(),
          approver: $("#f_approver").value.trim(),
          status: "검토중",
        });
        await saveModule("sns", data);
        closeModal();
        refreshCurrentTab();
      });
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
  if (item) item.status = status;
  await saveModule("sns", data);
  refreshCurrentTab();
}
