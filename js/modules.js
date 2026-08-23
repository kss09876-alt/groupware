// modules.js — 각 탭(모듈)의 데이터 스키마와 렌더링 로직

const FILES = {
  corp: "corp.json",
  notice: "notices.json",
  calendar: "calendar.json",
  approval: "approvals.json",
  attendance: "attendance.json",
  sns: "sns.json",
};

const DEFAULTS = {
  corp: {
    name: "",
    engName: "",
    regNo: "",
    bizNo: "",
    foundedDate: "",
    fiscalYear: "1월 ~ 12월",
    capital: "",
    capitalShares: "",
    parValue: "",
    address: "",
    branches: [],
    shareholders: [],
    officers: [],
    taxSchedule: [
      { name: "법인세", desc: "3월 말일까지 연 1회 신고·납부" },
      { name: "부가세", desc: "1, 4, 7, 10월 25일까지 연 4회 신고·납부" },
    ],
    articleFlags: {
      thirdPartyIssue: false,
      preferredStock: false,
      stockOption: false,
      transferRestriction: false,
    },
    meetings: {
      annual: "매년 1. 1. ~ 3. 31.에 1번 개최",
      special: "필요할 때마다 개최",
      board: "이사회 없음",
    },
    disclosureMethod: "",
    registeredPurposes: [],
    stockOptionRule: "정관 & 등기부에 스톡옵션 규정 없음",
    transferRestrictionRule: "정관 & 등기부에 주식양도제한 규정 없음",
    documents: {
      registry: { label: "법인등기부등본", fileId: null, fileName: null, webViewLink: null, updatedAt: null },
      articles: { label: "정관", fileId: null, fileName: null, webViewLink: null, updatedAt: null },
      bizReg: { label: "사업자등록증", fileId: null, fileName: null, webViewLink: null, updatedAt: null },
      shareholderList: { label: "주주명부", fileId: null, fileName: null, webViewLink: null, updatedAt: null },
    },
    seals: {
      corporate: { label: "법인인감", imageDataUrl: null, updatedAt: null },
      usage: { label: "사용인감", imageDataUrl: null, updatedAt: null },
    },
    sealedDocs: [],
  },
  notice: { items: [] },
  calendar: { items: [] },
  approval: { items: [] },
  attendance: { checkins: [], leaves: [] },
  sns: { items: [] },
};

// 예전에 저장된 corp.json(구버전 스키마)을 불러와도 깨지지 않도록,
// 새로 추가된 필드가 없으면 기본값으로 채워줍니다.
function normalizeCorp(c) {
  const d = DEFAULTS.corp;
  const out = { ...d, ...c };
  out.branches = c.branches || [];
  out.registeredPurposes = c.registeredPurposes || [];
  out.shareholders = c.shareholders || [];
  out.officers = c.officers || [];
  out.taxSchedule = c.taxSchedule || d.taxSchedule;
  out.articleFlags = { ...d.articleFlags, ...(c.articleFlags || {}) };
  out.meetings = { ...d.meetings, ...(c.meetings || {}) };
  out.documents = { ...d.documents, ...(c.documents || {}) };
  Object.keys(d.documents).forEach((key) => {
    out.documents[key] = { ...d.documents[key], ...(out.documents[key] || {}) };
  });
  out.seals = { ...d.seals, ...(c.seals || {}) };
  Object.keys(d.seals).forEach((key) => {
    out.seals[key] = { ...d.seals[key], ...(out.seals[key] || {}) };
  });
  out.sealedDocs = c.sealedDocs || [];
  return out;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function nowStr() {
  return new Date().toLocaleString("ko-KR");
}
function esc(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const Modules = {
  // ---------------- 대시보드 ----------------
  async dashboard(ctx) {
    const [notice, cal, appr, att, sns] = await Promise.all([
      ctx.load("notice"),
      ctx.load("calendar"),
      ctx.load("approval"),
      ctx.load("attendance"),
      ctx.load("sns"),
    ]);
    const myPendingApprovals = appr.items.filter((a) => a.status === "대기" && a.approver === ctx.user.email).length;
    const upcoming = cal.items
      .filter((e) => e.date >= todayStr())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 5);
    const recentNotices = [...notice.items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const todayCheckin = att.checkins.find((c) => c.email === ctx.user.email && c.date === todayStr());

    return `
      <div class="grid grid-4">
        <div class="stat-card">
          <div class="stat-label">오늘 출근 상태</div>
          <div class="stat-value">${todayCheckin ? (todayCheckin.checkOut ? "퇴근완료" : "출근중") : "미출근"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">내가 결재할 문서</div>
          <div class="stat-value">${myPendingApprovals}건</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">공지사항</div>
          <div class="stat-value">${notice.items.length}건</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">SNS 예정 게시물</div>
          <div class="stat-value">${sns.items.filter((s) => s.status !== "게시완료").length}건</div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="panel">
          <h3>다가오는 일정</h3>
          ${upcoming.length ? upcoming.map((e) => `<div class="list-row"><span class="tag">${esc(e.date)}</span>${esc(e.title)}</div>`).join("") : `<div class="empty">등록된 일정이 없어요.</div>`}
        </div>
        <div class="panel">
          <h3>최근 공지</h3>
          ${recentNotices.length ? recentNotices.map((n) => `<div class="list-row"><span class="tag">${esc(n.date)}</span>${esc(n.title)}</div>`).join("") : `<div class="empty">등록된 공지가 없어요.</div>`}
        </div>
      </div>
      <div class="quick-actions">
        <button class="btn btn-primary" data-quick="attendance">출퇴근 체크하기</button>
        <button class="btn btn-secondary" data-quick="approval">결재 올리기</button>
        <button class="btn btn-secondary" data-quick="notice">공지 작성하기</button>
      </div>
    `;
  },

  // ---------------- 법인정보 ----------------
  async corp(ctx) {
    const c = await ctx.load("corp");
    const sub = ctx.corpSubTab || "info";
    const nav = `
      <div class="subtab-nav">
        <button class="subtab-btn ${sub === "info" ? "active" : ""}" data-corp-subtab="info">법인정보</button>
        <button class="subtab-btn ${sub === "seal" ? "active" : ""}" data-corp-subtab="seal">인감관리</button>
      </div>`;
    const body = sub === "seal" ? Modules.corpSealBody(c) : Modules.corpInfoBody(c);
    return nav + body;
  },

  corpInfoBody(c) {
    const flags = c.articleFlags || {};
    const meetings = c.meetings || {};
    const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("ko-KR") : null);
    const docRow = (key, doc) => `
      <div class="doc-row">
        <div class="doc-info">
          <span class="doc-icon">📄</span>
          <div>
            <div class="doc-name">${esc(doc.label)}</div>
            <div class="doc-meta">${doc.updatedAt ? `${fmtDate(doc.updatedAt)} 업데이트` : "미등록"}</div>
          </div>
        </div>
        <div class="doc-actions">
          ${doc.webViewLink ? `<a class="btn btn-tiny btn-secondary" href="${esc(doc.webViewLink)}" target="_blank" rel="noopener">다운로드</a>` : ""}
          ${doc.fileId ? `<button class="btn btn-tiny btn-secondary ai-fill-btn" data-doc-key="${key}">🤖 AI로 채우기</button>` : ""}
          <label class="btn btn-tiny btn-primary doc-upload-label">
            ${doc.fileId ? "재업로드" : "업로드"}
            <input type="file" class="doc-upload-input" data-doc-key="${key}" hidden>
          </label>
        </div>
      </div>`;

    return `
      <div class="toolbar"><button class="btn btn-primary" id="editCorpBtn">기본정보 수정</button></div>
      <div class="grid grid-3 corp-grid">
        <div class="panel span-2">
          <h3>${esc(c.name) || "법인명 미등록"}</h3>
          ${Object.entries(c.documents || {}).map(([key, doc]) => docRow(key, doc)).join("")}
        </div>
        <div class="panel">
          <div class="stat-label">등록번호</div>
          <div class="corp-id">${esc(c.regNo) || "-"}</div>
          <div class="stat-label" style="margin-top:14px">사업자등록번호</div>
          <div class="corp-id">${esc(c.bizNo) || "-"}</div>
          ${c.foundedDate ? `<table class="kv" style="margin-top:14px"><tbody><tr><th>법인설립일</th><td>${esc(c.foundedDate)}</td></tr></tbody></table>` : ""}
        </div>

        <div class="panel capital-panel">
          <div class="stat-label">자본금</div>
          <div class="capital-amount">${esc(c.capital) || "-"}</div>
          <div class="muted" style="margin-left:0">${esc(c.capitalShares) || ""}${c.capitalShares && c.parValue ? " · " : ""}${esc(c.parValue) || ""}</div>
        </div>
        <div class="panel">
          <div class="toolbar" style="margin-bottom:8px"><h3 style="margin:0">주주 (총 ${c.shareholders.length}명)</h3><button class="btn btn-tiny btn-secondary" id="addShareholderBtn">+ 추가</button></div>
          ${c.shareholders.map((s, i) => `<div class="list-row">${esc(s.name)} <span class="tag">${esc(s.percent)}%</span><button class="btn btn-tiny btn-danger" data-del-shareholder="${i}">삭제</button></div>`).join("") || `<div class="empty">등록된 주주가 없어요.</div>`}
        </div>
        <div class="panel">
          <div class="toolbar" style="margin-bottom:8px"><h3 style="margin:0">임원 (총 ${c.officers.length}명)</h3><button class="btn btn-tiny btn-secondary" id="addOfficerBtn">+ 추가</button></div>
          ${c.officers.map((o, i) => `<div class="list-row">${esc(o.name)} <span class="tag">${esc(o.role)}</span> ${esc(o.term || "")}<button class="btn btn-tiny btn-danger" data-del-officer="${i}">삭제</button></div>`).join("") || `<div class="empty">등록된 임원이 없어요.</div>`}
        </div>

        <div class="panel">
          <h3>정관</h3>
          <div class="flag-row">제3자 신주발행 근거규정 ${flags.thirdPartyIssue ? "있음 ✓" : "없음 ✕"}</div>
          <div class="flag-row">우선주 발행 근거규정 ${flags.preferredStock ? "있음 ✓" : "없음 ✕"}</div>
          <div class="flag-row">스톡옵션 규정 ${flags.stockOption ? "있음 ✓" : "없음 ✕"}</div>
          <div class="flag-row">제3자 주식양도제한 규정 ${flags.transferRestriction ? "있음 ✓" : "없음 ✕"}</div>
        </div>
        <div class="panel">
          <h3>주주총회 · 이사회</h3>
          <table class="kv"><tbody>
            <tr><th>정기주주총회</th><td>${esc(meetings.annual) || "-"}</td></tr>
            <tr><th>임시주주총회</th><td>${esc(meetings.special) || "-"}</td></tr>
            <tr><th>이사회</th><td>${esc(meetings.board) || "-"}</td></tr>
          </tbody></table>
        </div>
        <div class="panel">
          <h3>세금일정</h3>
          ${c.taxSchedule.map((t) => `<div class="list-row"><b>${esc(t.name)}</b>&nbsp;${esc(t.desc)}</div>`).join("") || `<div class="empty">등록된 일정이 없어요.</div>`}
        </div>

        <div class="panel">
          <div class="toolbar" style="margin-bottom:8px"><h3 style="margin:0">본점 · 지점</h3><button class="btn btn-tiny btn-secondary" id="addBranchBtn">+ 지점 추가</button></div>
          <div class="list-row">본점 <span class="muted">${esc(c.address) || "미등록"}</span></div>
          ${c.branches.map((b, i) => `<div class="list-row">지점 <span class="muted">${esc(b)}</span><button class="btn btn-tiny btn-danger" data-del-branch="${i}">삭제</button></div>`).join("")}
        </div>
        <div class="panel">
          <h3>상호</h3>
          ${
            c.name || c.engName
              ? `<table class="kv"><tbody>
            ${c.name ? `<tr><th>한글</th><td>${esc(c.name)}</td></tr>` : ""}
            ${c.engName ? `<tr><th>영문</th><td>${esc(c.engName)}</td></tr>` : ""}
          </tbody></table>`
              : `<div class="empty">등록된 상호가 없어요.</div>`
          }
        </div>
      </div>
    `;
  },

  // ---------------- 인감관리 ----------------
  corpSealBody(c) {
    const seals = c.seals || {};
    const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("ko-KR") : null);
    const sealCard = (type, seal) => `
      <div class="panel seal-card">
        <div class="seal-card-head">
          <h3 style="margin:0">${esc(seal.label) || (type === "corporate" ? "법인인감" : "사용인감")}</h3>
          ${seal.imageDataUrl ? `<span class="muted">업데이트: ${fmtDate(seal.updatedAt)}</span>` : ""}
        </div>
        <div class="seal-preview">
          ${seal.imageDataUrl ? `<img src="${seal.imageDataUrl}" alt="${esc(seal.label)}" />` : `<div class="seal-empty">미등록</div>`}
        </div>
        <div class="doc-actions" style="justify-content:center; margin-top:10px;">
          <label class="btn btn-tiny btn-primary doc-upload-label">
            ${seal.imageDataUrl ? "이미지 변경" : "인감 등록"}
            <input type="file" class="seal-upload-input" accept="image/*" data-seal-type="${type}" hidden>
          </label>
          ${seal.imageDataUrl ? `<button class="btn btn-tiny btn-danger" data-del-seal="${type}">삭제</button>` : ""}
        </div>
      </div>`;

    const docs = (c.sealedDocs || [])
      .map(
        (d) => `
        <div class="list-row">
          <div>
            <b>${esc(d.name)}</b>
            <span class="tag">${esc(d.sealLabel)}</span>
            <span class="muted">${fmtDate(d.createdAt)}</span>
          </div>
          <div class="doc-actions">
            <button class="btn btn-tiny btn-secondary" data-download-sealed-doc data-file-id="${esc(d.fileId)}" data-file-name="${esc(d.name)}">다운로드</button>
            <button class="btn btn-tiny btn-danger" data-del-sealed-doc data-id="${esc(d.id)}">삭제</button>
          </div>
        </div>`
      )
      .join("");

    return `
      <p class="hint">등록한 인감 이미지(투명 배경 PNG 권장)를 서류(PDF)에 자동으로 찍어드려요. 정부 등기·공증 효력이 있는 정식 전자서명은 아니고, 사내에서 서류에 도장을 찍은 것처럼 표시해주는 기능이에요.</p>
      <div class="grid grid-2">
        ${sealCard("corporate", seals.corporate || {})}
        ${sealCard("usage", seals.usage || {})}
      </div>

      <div class="panel">
        <h3>도장 찍을 서류 업로드</h3>
        <p class="hint" style="margin-top:-4px">10MB 이하의 PDF 파일을 올려주세요. (jpg/png는 자동으로 1장짜리 PDF로 변환돼요)</p>
        <label class="btn btn-primary doc-upload-label">
          파일 선택
          <input type="file" id="sealDocInput" accept="application/pdf,image/png,image/jpeg" hidden>
        </label>
      </div>

      <div class="panel">
        <h3>날인된 문서 (총 ${(c.sealedDocs || []).length}건)</h3>
        ${docs || `<div class="empty">아직 날인한 문서가 없어요.</div>`}
      </div>
    `;
  },

  sealPlaceForm(fileName, seals) {
    const opts = [];
    if (seals.corporate && seals.corporate.imageDataUrl) opts.push({ v: "corporate", label: seals.corporate.label || "법인인감" });
    if (seals.usage && seals.usage.imageDataUrl) opts.push({ v: "usage", label: seals.usage.label || "사용인감" });
    return `
      <h3>도장 날인 — ${esc(fileName)}</h3>
      <div class="form-grid" style="margin-bottom:10px;">
        <label>사용할 도장
          <select id="f_sealType">
            ${opts.map((o) => `<option value="${o.v}">${esc(o.label)}</option>`).join("")}
          </select>
        </label>
        <label>페이지
          <select id="f_sealPageNum"></select>
        </label>
      </div>
      <p class="hint" style="margin-top:-4px">아래 서류 미리보기에서 도장을 찍을 위치를 클릭하세요.</p>
      <div class="seal-place-wrap" id="sealPlaceCanvasWrap">
        <canvas id="sealPlaceCanvas"></canvas>
        <img id="sealPlaceMarker" class="seal-place-marker" style="display:none" alt="도장 미리보기">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="confirmSealBtn" disabled>날인하기</button>
      </div>
    `;
  },

  corpEditForm(c) {
    const flags = c.articleFlags || {};
    const meetings = c.meetings || {};
    return `
      <h3>법인정보 수정</h3>
      <div class="form-grid">
        <label>회사명 <input id="f_name" value="${esc(c.name)}"></label>
        <label>영문명 <input id="f_engName" value="${esc(c.engName)}"></label>
        <label>법인등록번호 <input id="f_regNo" value="${esc(c.regNo)}"></label>
        <label>사업자등록번호 <input id="f_bizNo" value="${esc(c.bizNo)}"></label>
        <label>설립일 <input type="date" id="f_foundedDate" value="${esc(c.foundedDate)}"></label>
        <label>자본금 <input id="f_capital" value="${esc(c.capital)}" placeholder="10,000,000원"></label>
        <label>발행주식 <input id="f_capitalShares" value="${esc(c.capitalShares)}" placeholder="총 100,000주 / 1종류"></label>
        <label>액면가 <input id="f_parValue" value="${esc(c.parValue)}" placeholder="100,000주 X 액면금 100원"></label>
        <label>본점 주소 <input id="f_address" value="${esc(c.address)}"></label>
        <label>정기주주총회 <input id="f_annual" value="${esc(meetings.annual)}"></label>
        <label>임시주주총회 <input id="f_special" value="${esc(meetings.special)}"></label>
        <label>이사회 <input id="f_board" value="${esc(meetings.board)}"></label>
        <label class="checkbox-label"><input type="checkbox" id="f_thirdPartyIssue" ${flags.thirdPartyIssue ? "checked" : ""}> 제3자 신주발행 근거규정 있음</label>
        <label class="checkbox-label"><input type="checkbox" id="f_preferredStock" ${flags.preferredStock ? "checked" : ""}> 우선주 발행 근거규정 있음</label>
        <label class="checkbox-label"><input type="checkbox" id="f_stockOption" ${flags.stockOption ? "checked" : ""}> 스톡옵션 규정 있음</label>
        <label class="checkbox-label"><input type="checkbox" id="f_transferRestriction" ${flags.transferRestriction ? "checked" : ""}> 제3자 주식양도제한 규정 있음</label>
      </div>
      <p class="hint">주주·임원·지점은 저장 후 법인정보 화면의 각 카드에서 "+ 추가" 버튼으로 등록할 수 있어요.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveCorpBtn">저장</button>
      </div>
    `;
  },

  // AI가 서류에서 추출한 값을 사람이 확인하고 적용할지 결정하는 확인창
  aiReviewForm(label, fields) {
    const fmtVal = (v) => {
      if (Array.isArray(v)) {
        if (!v.length) return "(없음)";
        return v.map((item) => (item && typeof item === "object" ? Object.values(item).filter(Boolean).join(" / ") : String(item))).join(", ");
      }
      if (v && typeof v === "object") {
        return Object.entries(v).map(([k, vv]) => `${k}: ${typeof vv === "boolean" ? (vv ? "있음" : "없음") : vv}`).join(" · ");
      }
      return v === "" || v === null || v === undefined ? "(없음)" : String(v);
    };
    const rows = Object.entries(fields || {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(fmtVal(v))}</td></tr>`).join("");
    return `
      <h3>🤖 AI 추출 결과 확인 — ${esc(label)}</h3>
      <p class="hint">업로드한 서류에서 AI가 아래 정보를 읽어냈어요. 내용을 확인한 뒤 적용해주세요. AI가 잘못 읽었을 수 있으니, 적용 후에도 꼭 한 번 더 확인해주세요.</p>
      <table class="kv" style="margin-bottom:10px">${rows || `<tr><td class="empty">추출된 정보가 없어요.</td></tr>`}</table>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="applyAiBtn">이 내용으로 적용하기</button>
      </div>
    `;
  },

  // ---------------- 공지사항 ----------------
  async notice(ctx) {
    const data = await ctx.load("notice");
    const items = [...data.items].sort((a, b) => (b.pinned - a.pinned) || b.date.localeCompare(a.date));
    return `
      <div class="toolbar"><button class="btn btn-primary" id="newNoticeBtn">+ 새 공지</button></div>
      <div class="panel">
        ${items.length ? items.map((n) => `
          <div class="list-row expand" data-notice="${n.id}">
            <div>
              ${n.pinned ? '<span class="tag tag-pin">고정</span>' : ""}
              <b>${esc(n.title)}</b>
              <span class="muted">${esc(n.author)} · ${esc(n.date)}</span>
            </div>
            <button class="btn btn-tiny btn-danger" data-del-notice="${n.id}">삭제</button>
          </div>
          <div class="notice-body" id="body_${n.id}" style="display:none;">${esc(n.body).replace(/\n/g, "<br>")}</div>
        `).join("") : `<div class="empty">등록된 공지사항이 없어요.</div>`}
      </div>
    `;
  },

  noticeForm() {
    return `
      <h3>새 공지사항</h3>
      <div class="form-grid">
        <label>제목 <input id="f_title"></label>
        <label>내용 <textarea id="f_body" rows="6"></textarea></label>
        <label class="checkbox-label"><input type="checkbox" id="f_pinned"> 상단 고정</label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveNoticeBtn">등록</button>
      </div>
    `;
  },

  // ---------------- 캘린더 ----------------
  async calendar(ctx) {
    const data = await ctx.load("calendar");
    const items = [...data.items].sort((a, b) => a.date.localeCompare(b.date));
    return `
      <div class="toolbar"><button class="btn btn-primary" id="newEventBtn">+ 새 일정</button></div>
      <div class="panel">
        ${items.length ? items.map((e) => `
          <div class="list-row">
            <div><span class="tag">${esc(e.date)}${e.endDate ? " ~ " + esc(e.endDate) : ""}</span> <b>${esc(e.title)}</b> <span class="muted">${esc(e.memo || "")}</span></div>
            <button class="btn btn-tiny btn-danger" data-del-event="${e.id}">삭제</button>
          </div>
        `).join("") : `<div class="empty">등록된 일정이 없어요.</div>`}
      </div>
    `;
  },

  eventForm() {
    return `
      <h3>새 일정</h3>
      <div class="form-grid">
        <label>제목 <input id="f_title"></label>
        <label>시작일 <input type="date" id="f_date" value="${todayStr()}"></label>
        <label>종료일 (선택) <input type="date" id="f_endDate"></label>
        <label>메모 <textarea id="f_memo" rows="3"></textarea></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveEventBtn">등록</button>
      </div>
    `;
  },

  // ---------------- 전자결재 ----------------
  async approval(ctx) {
    const data = await ctx.load("approval");
    const items = [...data.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const statusTag = (s) => `<span class="tag ${s === "승인" ? "tag-ok" : s === "반려" ? "tag-no" : "tag-wait"}">${s}</span>`;
    return `
      <div class="toolbar"><button class="btn btn-primary" id="newApprovalBtn">+ 결재 상신</button></div>
      <div class="panel">
        ${items.length ? items.map((a) => `
          <div class="list-row expand" data-approval="${a.id}">
            <div>
              ${statusTag(a.status)}
              <b>[${esc(a.type)}] ${esc(a.title)}</b>
              <span class="muted">기안 ${esc(a.requester)} → 결재 ${esc(a.approver)} · ${esc(a.createdAt)}</span>
            </div>
            ${a.status === "대기" && a.approver === ctx.user.email ? `
              <span>
                <button class="btn btn-tiny btn-primary" data-approve="${a.id}">승인</button>
                <button class="btn btn-tiny btn-danger" data-reject="${a.id}">반려</button>
              </span>` : ""}
          </div>
          <div class="notice-body" id="abody_${a.id}" style="display:none;">${esc(a.body).replace(/\n/g, "<br>")}</div>
        `).join("") : `<div class="empty">결재 문서가 없어요.</div>`}
      </div>
    `;
  },

  approvalForm() {
    return `
      <h3>결재 상신</h3>
      <div class="form-grid">
        <label>문서 유형
          <select id="f_type">
            <option>지출결의서</option><option>휴가신청서</option><option>품의서</option><option>기타</option>
          </select>
        </label>
        <label>제목 <input id="f_title"></label>
        <label>내용 <textarea id="f_body" rows="5"></textarea></label>
        <label>결재자 이메일 <input id="f_approver" placeholder="approver@company.com"></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveApprovalBtn">상신</button>
      </div>
    `;
  },

  // ---------------- 근태관리 ----------------
  async attendance(ctx) {
    const data = await ctx.load("attendance");
    const my = data.checkins.find((c) => c.email === ctx.user.email && c.date === todayStr());
    const todayList = data.checkins.filter((c) => c.date === todayStr()).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
    const leaves = [...data.leaves].sort((a, b) => b.startDate.localeCompare(a.startDate));
    const statusTag = (s) => `<span class="tag ${s === "승인" ? "tag-ok" : s === "반려" ? "tag-no" : "tag-wait"}">${s}</span>`;
    return `
      <div class="grid grid-2">
        <div class="panel">
          <h3>오늘 출퇴근 (${todayStr()})</h3>
          <div class="attendance-box">
            <div class="attendance-status">${my ? (my.checkOut ? `${my.checkIn} 출근 · ${my.checkOut} 퇴근` : `${my.checkIn} 출근중`) : "아직 출근 전이에요"}</div>
            <div>
              <button class="btn btn-primary" id="checkInBtn" ${my ? "disabled" : ""}>출근</button>
              <button class="btn btn-secondary" id="checkOutBtn" ${!my || my.checkOut ? "disabled" : ""}>퇴근</button>
            </div>
          </div>
          <h4>오늘 전체 출근 현황</h4>
          ${todayList.length ? todayList.map((c) => `<div class="list-row">${esc(c.name)} <span class="muted">${esc(c.checkIn)}${c.checkOut ? " ~ " + esc(c.checkOut) : ""}</span></div>`).join("") : `<div class="empty">오늘 출근 기록이 없어요.</div>`}
        </div>
        <div class="panel">
          <div class="toolbar"><h3 style="margin:0">휴가 신청</h3><button class="btn btn-primary btn-tiny" id="newLeaveBtn">+ 신청</button></div>
          ${leaves.length ? leaves.map((l) => `
            <div class="list-row">
              <div>${statusTag(l.status)} <b>${esc(l.name)}</b> ${esc(l.type)} <span class="muted">${esc(l.startDate)} ~ ${esc(l.endDate)}</span></div>
              ${l.status === "대기" && l.approver === ctx.user.email ? `
                <span>
                  <button class="btn btn-tiny btn-primary" data-leave-approve="${l.id}">승인</button>
                  <button class="btn btn-tiny btn-danger" data-leave-reject="${l.id}">반려</button>
                </span>` : ""}
            </div>
          `).join("") : `<div class="empty">신청된 휴가가 없어요.</div>`}
        </div>
      </div>
    `;
  },

  leaveForm() {
    return `
      <h3>휴가 신청</h3>
      <div class="form-grid">
        <label>휴가 종류
          <select id="f_type"><option>연차</option><option>반차</option><option>병가</option><option>경조사</option></select>
        </label>
        <label>시작일 <input type="date" id="f_start" value="${todayStr()}"></label>
        <label>종료일 <input type="date" id="f_end" value="${todayStr()}"></label>
        <label>사유 <textarea id="f_reason" rows="3"></textarea></label>
        <label>승인자 이메일 <input id="f_approver" placeholder="approver@company.com"></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveLeaveBtn">신청</button>
      </div>
    `;
  },

  // ---------------- SNS 운영 ----------------
  async sns(ctx) {
    const data = await ctx.load("sns");
    const items = [...data.items].sort((a, b) => (a.scheduledAt || a.date).localeCompare(b.scheduledAt || b.date));
    const statusTag = (s) => `<span class="tag ${s === "게시완료" ? "tag-ok" : s === "반려" ? "tag-no" : s === "승인" ? "tag-ok" : "tag-wait"}">${s}</span>`;
    const upcoming = items
      .filter((s) => s.status === "승인" && s.autoPublish && s.scheduledAt)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, 5);
    return `
      <div class="toolbar"><button class="btn btn-primary" id="newSnsBtn">+ 콘텐츠 등록</button></div>
      <p class="hint">✅ 예약 자동화: "자동 게시 처리"를 켜고 승인하면, 예정 시각이 되었을 때 앱이 열려있는 시점에 자동으로 "게시완료"로 바뀌고 캘린더에도 자동 등록돼요. (브라우저가 실제로 열려있어야 동작해요 — 완전한 백그라운드 자동 게시는 별도 서버 연동이 필요해요.)<br>※ 실제 인스타그램/페이스북 등에 자동으로 업로드하는 기능은 각 플랫폼 API 연동이 추가로 필요해요. 지금은 콘텐츠 캘린더 + 담당자 배정 + 승인 → 예약 자동화 워크플로우까지 지원해요.</p>
      ${upcoming.length ? `
      <div class="panel" style="margin-bottom:16px;">
        <h3>🤖 자동 게시 예정</h3>
        ${upcoming.map((s) => `<div class="list-row"><div><span class="tag">${esc(s.date)} ${esc(s.time || "")}</span> <span class="tag">${esc(s.platform)}</span> ${esc(s.title)}</div></div>`).join("")}
      </div>` : ""}
      <div class="panel">
        ${items.length ? items.map((s) => `
          <div class="list-row expand" data-sns="${s.id}">
            <div>
              ${statusTag(s.status)}
              <span class="tag">${esc(s.platform)}</span>
              ${s.autoPublish ? `<span class="tag tag-ok">🤖 자동게시</span>` : ""}
              <b>${esc(s.title)}</b>
              <span class="muted">담당 ${esc(s.assignee)} · 게시예정 ${esc(s.date)}${s.time ? " " + esc(s.time) : ""}</span>
            </div>
            <span>
              ${s.status === "검토중" ? `<button class="btn btn-tiny btn-primary" data-sns-approve="${s.id}">승인</button><button class="btn btn-tiny btn-danger" data-sns-reject="${s.id}">반려</button>` : ""}
              ${s.status === "승인" ? `<button class="btn btn-tiny btn-primary" data-sns-publish="${s.id}">게시완료 처리</button>` : ""}
              <button class="btn btn-tiny btn-danger" data-del-sns="${s.id}">삭제</button>
            </span>
          </div>
          <div class="notice-body" id="sbody_${s.id}" style="display:none;">${esc(s.content).replace(/\n/g, "<br>")}</div>
        `).join("") : `<div class="empty">등록된 SNS 콘텐츠가 없어요.</div>`}
      </div>
    `;
  },

  snsForm() {
    return `
      <h3>SNS 콘텐츠 등록</h3>
      <div class="form-grid">
        <label>플랫폼
          <select id="f_platform"><option>인스타그램</option><option>페이스북</option><option>블로그</option><option>유튜브</option><option>기타</option></select>
        </label>
        <label>제목 <input id="f_title"></label>
        <label>내용/초안 <textarea id="f_content" rows="5"></textarea></label>
        <label>담당자 이름 <input id="f_assignee"></label>
        <label>게시 예정일 <input type="date" id="f_date" value="${todayStr()}"></label>
        <label>게시 예정 시각 <input type="time" id="f_time" value="09:00"></label>
        <label class="checkbox-label"><input type="checkbox" id="f_autoPublish" checked> 승인되면 예정 시각에 자동으로 "게시완료" 처리 + 캘린더 자동 등록</label>
        <label>승인자 이메일 <input id="f_approver" placeholder="approver@company.com"></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveSnsBtn">등록 (검토요청)</button>
      </div>
    `;
  },
};
