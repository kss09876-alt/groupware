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
    address: "",
    shareholders: [],
    officers: [],
    taxSchedule: [
      { name: "법인세", desc: "3월 말일까지 연 1회 신고·납부" },
      { name: "부가세", desc: "1, 4, 7, 10월 25일까지 연 4회 신고·납부" },
    ],
  },
  notice: { items: [] },
  calendar: { items: [] },
  approval: { items: [] },
  attendance: { checkins: [], leaves: [] },
  sns: { items: [] },
};

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
    return `
      <div class="toolbar"><button class="btn btn-primary" id="editCorpBtn">법인정보 수정</button></div>
      <div class="grid grid-2">
        <div class="panel">
          <h3>기본정보</h3>
          <table class="kv"><tbody>
            <tr><th>회사명</th><td>${esc(c.name) || "-"}</td></tr>
            <tr><th>영문명</th><td>${esc(c.engName) || "-"}</td></tr>
            <tr><th>법인등록번호</th><td>${esc(c.regNo) || "-"}</td></tr>
            <tr><th>사업자등록번호</th><td>${esc(c.bizNo) || "-"}</td></tr>
            <tr><th>설립일</th><td>${esc(c.foundedDate) || "-"}</td></tr>
            <tr><th>사업연도</th><td>${esc(c.fiscalYear) || "-"}</td></tr>
            <tr><th>자본금</th><td>${esc(c.capital) || "-"}</td></tr>
            <tr><th>본점 주소</th><td>${esc(c.address) || "-"}</td></tr>
          </tbody></table>
        </div>
        <div class="panel">
          <h3>세금일정</h3>
          ${c.taxSchedule.map((t) => `<div class="list-row"><b>${esc(t.name)}</b>&nbsp;${esc(t.desc)}</div>`).join("") || `<div class="empty">등록된 일정이 없어요.</div>`}
        </div>
        <div class="panel">
          <h3>주주 (총 ${c.shareholders.length}명)</h3>
          ${c.shareholders.map((s) => `<div class="list-row">${esc(s.name)} <span class="tag">${esc(s.percent)}%</span></div>`).join("") || `<div class="empty">등록된 주주가 없어요.</div>`}
        </div>
        <div class="panel">
          <h3>임원 (총 ${c.officers.length}명)</h3>
          ${c.officers.map((o) => `<div class="list-row">${esc(o.name)} <span class="tag">${esc(o.role)}</span> ${esc(o.term || "")}</div>`).join("") || `<div class="empty">등록된 임원이 없어요.</div>`}
        </div>
      </div>
    `;
  },

  corpEditForm(c) {
    return `
      <h3>법인정보 수정</h3>
      <div class="form-grid">
        <label>회사명 <input id="f_name" value="${esc(c.name)}"></label>
        <label>영문명 <input id="f_engName" value="${esc(c.engName)}"></label>
        <label>법인등록번호 <input id="f_regNo" value="${esc(c.regNo)}"></label>
        <label>사업자등록번호 <input id="f_bizNo" value="${esc(c.bizNo)}"></label>
        <label>설립일 <input type="date" id="f_foundedDate" value="${esc(c.foundedDate)}"></label>
        <label>사업연도 <input id="f_fiscalYear" value="${esc(c.fiscalYear)}"></label>
        <label>자본금 <input id="f_capital" value="${esc(c.capital)}"></label>
        <label>본점 주소 <input id="f_address" value="${esc(c.address)}"></label>
      </div>
      <p class="hint">주주·임원 명단은 저장 후 각 카드에서 추가/삭제할 수 있도록 다음 업데이트에서 지원 예정이에요. 지금은 JSON을 드라이브에서 직접 편집할 수도 있어요.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveCorpBtn">저장</button>
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
    const items = [...data.items].sort((a, b) => a.date.localeCompare(b.date));
    const statusTag = (s) => `<span class="tag ${s === "게시완료" ? "tag-ok" : s === "반려" ? "tag-no" : s === "승인" ? "tag-ok" : "tag-wait"}">${s}</span>`;
    return `
      <div class="toolbar"><button class="btn btn-primary" id="newSnsBtn">+ 콘텐츠 등록</button></div>
      <p class="hint">※ 실제 인스타그램/페이스북 등에 자동 게시하는 기능은 각 플랫폼 API 연동이 추가로 필요해요. 지금은 콘텐츠 캘린더 + 담당자 배정 + 승인 워크플로우까지 지원해요.</p>
      <div class="panel">
        ${items.length ? items.map((s) => `
          <div class="list-row expand" data-sns="${s.id}">
            <div>
              ${statusTag(s.status)}
              <span class="tag">${esc(s.platform)}</span>
              <b>${esc(s.title)}</b>
              <span class="muted">담당 ${esc(s.assignee)} · 게시예정 ${esc(s.date)}</span>
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
        <label>승인자 이메일 <input id="f_approver" placeholder="approver@company.com"></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close>취소</button>
        <button class="btn btn-primary" id="saveSnsBtn">등록 (검토요청)</button>
      </div>
    `;
  },
};
