// bank.js — 회계관리 > 은행 거래내역 / 부가세 / 세금·손익 하위탭
//
// 기업은행 인터넷뱅킹에서 받은 거래내역(엑셀/CSV)을 올리면 브라우저 안에서 바로 읽어서
// 입금/출금을 계정으로 분류하고, 부가세·원천세·손익을 추정해 보여줘요.
// (AI 서버 없이 동작해요. 분류는 키워드 규칙 + 사용자가 직접 고치는 방식이에요.)
// 모든 금액은 "은행 입출금 기준 추정치"예요 — 세금계산서·카드·현금영수증 자료와 반드시 대조하세요.

const BANK_CATS = [
  // name, 방향(in/out), vat 기본값(taxable 과세 / exempt 면세·영세 / none 해당없음), pl 손익 반영 여부
  { name: "매출(과세)", dir: "in", vat: "taxable", sales: true, pl: true },
  { name: "매출(면세·영세)", dir: "in", vat: "exempt", sales: true, pl: true },
  { name: "이자수익", dir: "in", vat: "none", pl: true },
  { name: "기타입금", dir: "in", vat: "none", pl: true },
  { name: "대출·차입금", dir: "in", vat: "none", pl: false },
  { name: "자본금·출자", dir: "in", vat: "none", pl: false },
  { name: "세금 환급", dir: "in", vat: "none", pl: false },
  { name: "임차료", dir: "out", vat: "taxable", pl: true },
  { name: "통신비", dir: "out", vat: "taxable", pl: true },
  { name: "광고선전비", dir: "out", vat: "taxable", pl: true },
  { name: "소모품·사무용품", dir: "out", vat: "taxable", pl: true },
  { name: "외주·용역비(세금계산서)", dir: "out", vat: "taxable", pl: true },
  { name: "지급수수료", dir: "out", vat: "taxable", pl: true },
  { name: "운반·택배비", dir: "out", vat: "taxable", pl: true },
  { name: "복리후생·식대", dir: "out", vat: "none", pl: true },
  { name: "접대비", dir: "out", vat: "none", pl: true },
  { name: "급여(근로소득)", dir: "out", vat: "none", pl: true },
  { name: "사업소득 지급(3.3%)", dir: "out", vat: "none", pl: true },
  { name: "4대보험", dir: "out", vat: "none", pl: true },
  { name: "원천세·세금공과", dir: "out", vat: "none", pl: true, tax: true },
  { name: "부가세 납부", dir: "out", vat: "none", pl: false },
  { name: "법인세 납부", dir: "out", vat: "none", pl: false },
  { name: "이자비용", dir: "out", vat: "none", pl: true },
  { name: "대출상환", dir: "out", vat: "none", pl: false },
  { name: "내부이체·대표자", dir: "both", vat: "none", pl: false },
  { name: "기타지출", dir: "out", vat: "none", pl: true },
];
const BANK_VAT_LABEL = { taxable: "과세", exempt: "면세·영세", none: "해당없음" };

let bankState = { month: "latest", cat: "all", dir: "all", vatYear: new Date().getFullYear(), vatPeriod: "", taxYear: new Date().getFullYear() };

function bankCat(name) {
  return BANK_CATS.find((c) => c.name === name) || BANK_CATS.find((c) => c.name === "기타지출");
}
function won(n) {
  return (Math.round(Number(n) || 0)).toLocaleString("ko-KR");
}

// ---------- 분류 규칙 ----------
function bankGuessCategory(tx, bizNames) {
  const text = ((tx.desc || "") + " " + (tx.counterparty || "") + " " + (tx.memo || "")).toLowerCase();
  const has = (...ws) => ws.some((w) => text.includes(w.toLowerCase()));
  if (tx.deposit > 0) {
    if (has("이자")) return "이자수익";
    if (has("대출")) return "대출·차입금";
    if (has("환급", "국세환급")) return "세금 환급";
    if (has("출자", "증자", "자본금")) return "자본금·출자";
    return "매출(과세)";
  }
  const nameHit = (bizNames || []).some((n) => n && text.includes(n.toLowerCase()));
  if (nameHit) return "사업소득 지급(3.3%)";
  if (has("부가가치세", "부가세")) return "부가세 납부";
  if (has("법인세")) return "법인세 납부";
  if (has("국세", "세무서", "홈택스", "지방세", "위택스", "지방소득세", "원천세", "주민세")) return "원천세·세금공과";
  if (has("국민연금", "건강보험", "고용보험", "산재보험", "4대보험", "사회보험")) return "4대보험";
  if (has("급여", "월급", "상여")) return "급여(근로소득)";
  if (has("월세", "임대료", "임차", "관리비")) return "임차료";
  if (has("skt", "kt ", "lgu", "lg u", "통신", "인터넷", "세종텔레콤")) return "통신비";
  if (has("광고", "카카오모먼트", "네이버광고", "구글", "google", "메타", "facebook", "인스타")) return "광고선전비";
  if (has("식대", "배달", "음식", "식당", "카페", "스타벅스", "편의점", "gs25", "cu ")) return "복리후생·식대";
  if (has("쿠팡", "다이소", "문구", "사무", "오피스", "11번가", "g마켓", "옥션")) return "소모품·사무용품";
  if (has("택배", "cj대한통운", "한진", "로젠", "우체국", "물류")) return "운반·택배비";
  if (has("수수료")) return "지급수수료";
  if (has("대출상환", "원리금", "원금상환")) return "대출상환";
  if (has("이자")) return "이자비용";
  return "기타지출";
}

// ---------- 거래내역 파일 읽기 (엑셀/CSV) ----------
function bankParseNumber(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}
function bankParseDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number" && v > 30000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const m = String(v || "").match(/(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const m2 = String(v || "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return "";
}

async function bankReadFile(file) {
  await ensureXlsxLib();
  const buf = await file.arrayBuffer();
  let wb;
  if (/\.(csv|txt)$/i.test(file.name)) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder("euc-kr").decode(buf); }
    wb = XLSX.read(text, { type: "string", cellDates: true });
  } else {
    wb = XLSX.read(buf, { type: "array", cellDates: true });
  }
  let best = [];
  wb.SheetNames.forEach((sn) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: "" });
    const parsed = bankRowsToTx(rows);
    if (parsed.length > best.length) best = parsed;
  });
  return best;
}

function bankRowsToTx(rows) {
  // 머리글 행 찾기: "거래일" + ("입금" 또는 "출금")이 같이 있는 행
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const line = rows[i].map((c) => String(c)).join("|");
    if (/거래일|일자|일시/.test(line) && /입금|출금|지급|맡기신|찾으신/.test(line)) { hi = i; break; }
  }
  if (hi < 0) return [];
  const head = rows[hi].map((c) => String(c).replace(/\s/g, ""));
  const find = (re, skip) => head.findIndex((h, i) => re.test(h) && !(skip && skip.includes(i)));
  const iDate = find(/거래일|일자|일시/);
  const iWd = find(/출금|찾으신|지급액|지급금액/);
  const iDep = find(/입금|맡기신/);
  const iBal = find(/잔액/);
  const iDesc = find(/거래내용|적요|내용|기재/);
  const iCp = find(/상대|예금주|수취인|보낸|받는|의뢰인/);
  const iMemo = find(/메모|비고/);
  if (iDate < 0 || (iWd < 0 && iDep < 0)) return [];
  const out = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    const date = bankParseDate(row[iDate]);
    if (!date) continue;
    const deposit = iDep >= 0 ? bankParseNumber(row[iDep]) : 0;
    const withdraw = iWd >= 0 ? bankParseNumber(row[iWd]) : 0;
    if (!deposit && !withdraw) continue;
    const timeM = String(row[iDate]).match(/(\d{1,2}):(\d{2})/);
    out.push({
      date,
      time: timeM ? timeM[1].padStart(2, "0") + ":" + timeM[2] : "",
      desc: iDesc >= 0 ? String(row[iDesc]).trim() : "",
      counterparty: iCp >= 0 && iCp !== iDesc ? String(row[iCp]).trim() : "",
      memo: iMemo >= 0 ? String(row[iMemo]).trim() : "",
      deposit,
      withdraw,
      balance: iBal >= 0 ? bankParseNumber(row[iBal]) : 0,
    });
  }
  return out;
}

function bankTxKey(t) {
  return [t.date, t.time || "", t.deposit || 0, t.withdraw || 0, t.balance || 0, (t.desc || "") + (t.counterparty || "")].join("|");
}
function bankTxAmount(t) {
  return t.deposit > 0 ? t.deposit : t.withdraw;
}

// ---------- 부가세 계산 (금액은 부가세 포함 공급대가로 가정) ----------
function bankVatParts(t) {
  const gross = bankTxAmount(t);
  if (t.vat === "taxable") {
    const supply = Math.round(gross / 1.1);
    return { supply, vat: gross - supply };
  }
  if (t.vat === "exempt") return { supply: gross, vat: 0 };
  return { supply: 0, vat: 0 };
}
const VAT_PERIODS = [
  { key: "1", label: "1기 예정", from: "01", to: "03", due: "04-25" },
  { key: "2", label: "1기 확정", from: "04", to: "06", due: "07-25" },
  { key: "3", label: "2기 예정", from: "07", to: "09", due: "10-25" },
  { key: "4", label: "2기 확정", from: "10", to: "12", due: "01-25", nextYear: true },
];
function bankVatSummary(txs, year) {
  return VAT_PERIODS.map((p) => {
    const list = txs.filter((t) => t.date >= `${year}-${p.from}-01` && t.date <= `${year}-${p.to}-31`);
    let sTax = 0, sVat = 0, sEx = 0, pTax = 0, pVat = 0, cnt = 0;
    list.forEach((t) => {
      const c = bankCat(t.category);
      const { supply, vat } = bankVatParts(t);
      if (t.deposit > 0 && c.sales) {
        if (t.vat === "taxable") { sTax += supply; sVat += vat; cnt++; }
        else if (t.vat === "exempt") { sEx += supply; cnt++; }
      } else if (t.withdraw > 0 && t.vat === "taxable") {
        pTax += supply; pVat += vat; cnt++;
      }
    });
    const dueDate = `${p.nextYear ? year + 1 : year}-${p.due}`;
    return { ...p, year, dueDate, sTax, sVat, sEx, pTax, pVat, net: sVat - pVat, cnt, list };
  });
}

// ---------- 하위탭 렌더링 ----------
function bankSubtabNav(sub) {
  const b = (k, l) => `<button class="subtab-btn ${sub === k ? "active" : ""}" data-accounting-subtab="${k}">${l}</button>`;
  return `<div class="subtab-nav">${b("biztax", "사업소득 신고내역")}${b("bank", "은행 거래내역")}${b("vat", "부가세")}${b("tax", "세금·손익·일정")}</div>`;
}

function bankMonths(txs) {
  return [...new Set(txs.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

function bankBody(data) {
  const txs = (data.bankTx || []).slice().sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
  const months = bankMonths(txs);
  const s = bankState;
  const monthSel = s.month === "latest" ? months[0] || "all" : s.month;
  let shown = txs;
  if (monthSel !== "all") shown = shown.filter((t) => t.date.startsWith(monthSel));
  if (s.cat !== "all") shown = shown.filter((t) => t.category === s.cat);
  if (s.dir === "in") shown = shown.filter((t) => t.deposit > 0);
  if (s.dir === "out") shown = shown.filter((t) => t.withdraw > 0);
  const sumIn = shown.reduce((a, t) => a + (t.deposit || 0), 0);
  const sumOut = shown.reduce((a, t) => a + (t.withdraw || 0), 0);
  const catOpts = (cur, dir) =>
    BANK_CATS.filter((c) => c.dir === "both" || c.dir === dir).map((c) => `<option ${cur === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const rows = shown.slice(0, 400).map((t) => {
    const dir = t.deposit > 0 ? "in" : "out";
    return `<tr>
      <td>${esc(t.date)}</td>
      <td style="white-space:normal; min-width:160px;">${esc(t.desc)}${t.counterparty ? ` <span class="muted">(${esc(t.counterparty)})</span>` : ""}</td>
      <td class="num">${t.deposit ? won(t.deposit) : ""}</td>
      <td class="num">${t.withdraw ? won(t.withdraw) : ""}</td>
      <td class="num muted">${t.balance ? won(t.balance) : ""}</td>
      <td><select data-bank-cat="${esc(t.id)}">${catOpts(t.category, dir)}</select></td>
      <td><select data-bank-vat="${esc(t.id)}">${Object.keys(BANK_VAT_LABEL).map((k) => `<option value="${k}" ${t.vat === k ? "selected" : ""}>${BANK_VAT_LABEL[k]}</option>`).join("")}</select></td>
      <td><button class="btn btn-secondary" data-bank-del="${esc(t.id)}">삭제</button></td>
    </tr>`;
  }).join("");
  const allCats = BANK_CATS.map((c) => `<option ${s.cat === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  return `
    <div class="toolbar" style="gap:8px; flex-wrap:wrap;">
      <button class="btn btn-secondary" id="bankAddBtn">+ 직접 추가</button>
      <button class="btn btn-secondary" id="bankClearBtn">전체 삭제</button>
      <button class="btn btn-primary" id="bankUploadBtn">기업은행 거래내역 올리기 (엑셀/CSV)</button>
      <input type="file" id="bankFileInput" accept=".xlsx,.xls,.csv,.txt" hidden>
    </div>
    <div class="panel">
      <div class="filter-inline" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <select id="bankMonthFilter"><option value="all">전체 기간</option>${months.map((m) => `<option ${m === monthSel ? "selected" : ""}>${m}</option>`).join("")}</select>
        <select id="bankDirFilter">
          <option value="all">입출금 전체</option>
          <option value="in" ${s.dir === "in" ? "selected" : ""}>입금만</option>
          <option value="out" ${s.dir === "out" ? "selected" : ""}>출금만</option>
        </select>
        <select id="bankCatFilter"><option value="all">분류 전체</option>${allCats}</select>
        <span class="muted">${shown.length}건 · 입금 ${won(sumIn)}원 · 출금 ${won(sumOut)}원${shown.length > 400 ? " · 400건까지만 표시" : ""}</span>
      </div>
      <p class="hint" style="margin-top:8px;">기업은행 인터넷뱅킹 → 거래내역조회 → 엑셀(또는 CSV)로 저장한 파일을 올려주세요. 분류는 내용·상대방 이름으로 자동 추정한 값이니, 틀린 건 아래에서 바로 고치면 부가세·손익 집계에 반영돼요. 같은 내역을 다시 올려도 중복은 자동으로 걸러져요.</p>
    </div>
    <div class="panel" style="overflow-x:auto;">
      ${rows ? `<table class="data-table"><thead><tr><th>일자</th><th>거래내용</th><th>입금</th><th>출금</th><th>잔액</th><th>분류</th><th>부가세</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="muted">거래내역이 없어요. 위 버튼으로 파일을 올려주세요.</div>`}
    </div>`;
}

function bankImportReviewForm(rows, dupCount) {
  const catOpts = (cur, dir) => BANK_CATS.filter((c) => c.dir === "both" || c.dir === dir).map((c) => `<option ${cur === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const body = rows.map((r, i) => `<tr>
    <td><input type="checkbox" data-imp-chk="${i}" ${r._dup ? "" : "checked"}></td>
    <td>${esc(r.date)}</td>
    <td style="white-space:normal; min-width:150px;">${esc(r.desc)}${r.counterparty ? ` <span class="muted">(${esc(r.counterparty)})</span>` : ""}${r._dup ? ` <span class="tag tag-wait">중복</span>` : ""}</td>
    <td class="num">${r.deposit ? won(r.deposit) : ""}</td>
    <td class="num">${r.withdraw ? won(r.withdraw) : ""}</td>
    <td><select data-imp-cat="${i}">${catOpts(r.category, r.deposit > 0 ? "in" : "out")}</select></td>
  </tr>`).join("");
  return `
    <h3>거래내역 확인 (${rows.length}건)</h3>
    <p class="hint">체크된 항목만 등록돼요${dupCount ? ` (이미 등록된 ${dupCount}건은 체크가 해제돼 있어요)` : ""}. 분류가 틀렸다면 여기서 바꿔주세요.</p>
    <div style="max-height:52vh; overflow:auto;"><table class="data-table"><thead><tr><th></th><th>일자</th><th>거래내용</th><th>입금</th><th>출금</th><th>분류</th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close>취소</button>
      <button class="btn btn-primary" id="bankImportConfirmBtn">선택 항목 등록</button>
    </div>`;
}

function bankManualForm() {
  return `
    <h3>거래 직접 추가</h3>
    <div class="form-grid">
      <label>일자 <input type="date" id="bm_date" value="${todayStr()}"></label>
      <label>구분 <select id="bm_dir"><option value="in">입금</option><option value="out">출금</option></select></label>
      <label>금액 (원) <input type="number" id="bm_amount" min="0" step="1"></label>
      <label>거래내용 <input id="bm_desc"></label>
      <label>상대방 <input id="bm_cp"></label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close>취소</button>
      <button class="btn btn-primary" id="bankManualSaveBtn">추가</button>
    </div>`;
}

function vatBody(data) {
  const txs = data.bankTx || [];
  const s = bankState;
  const years = [...new Set(txs.map((t) => Number(t.date.slice(0, 4))).concat([new Date().getFullYear()]))].sort().reverse();
  const sum = bankVatSummary(txs, s.vatYear);
  const today = todayStr();
  const sel = s.vatPeriod || (sum.find((p) => p.dueDate >= today) || sum[3]).key;
  const cur = sum.find((p) => p.key === sel) || sum[0];
  const dTag = (due) => {
    const d = Math.round((new Date(due) - new Date(today)) / 86400000);
    return d < 0 ? `<span class="tag">기한 지남</span>` : `<span class="tag ${d <= 14 ? "tag-no" : d <= 45 ? "tag-wait" : ""}">D-${d}</span>`;
  };
  const rows = sum.map((p) => `<tr data-vat-period="${p.key}" style="cursor:pointer; ${p.key === sel ? "background:#f3f6ff;" : ""}">
    <td><strong>${p.label}</strong> <span class="muted">${s.vatYear}.${p.from}~${p.to}</span></td>
    <td>${p.dueDate} ${dTag(p.dueDate)}</td>
    <td class="num">${won(p.sTax)}</td><td class="num">${won(p.sVat)}</td>
    <td class="num">${won(p.pTax)}</td><td class="num">${won(p.pVat)}</td>
    <td class="num"><strong>${p.net >= 0 ? won(p.net) : "환급 " + won(-p.net)}</strong></td>
  </tr>`).join("");
  const detail = cur.list.filter((t) => t.vat !== "none" && (t.deposit > 0 ? bankCat(t.category).sales : true)).sort((a, b) => a.date.localeCompare(b.date)).map((t) => {
    const { supply, vat } = bankVatParts(t);
    return `<tr><td>${esc(t.date)}</td><td>${t.deposit > 0 ? "매출" : "매입"}</td><td style="white-space:normal;">${esc(t.desc)} <span class="muted">${esc(t.counterparty)}</span></td><td>${esc(t.category)}</td><td class="num">${won(bankTxAmount(t))}</td><td class="num">${won(supply)}</td><td class="num">${won(vat)}</td></tr>`;
  }).join("");
  return `
    <div class="panel">
      <div class="filter-inline" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <select id="vatYearSel">${years.map((y) => `<option ${y === s.vatYear ? "selected" : ""}>${y}</option>`).join("")}</select>
        <span class="muted">은행 입출금(부가세 포함 금액)에서 공급가액 = 금액 ÷ 1.1 로 추정한 값이에요.</span>
      </div>
      <p class="hint" style="margin-top:8px;">'은행 거래내역' 탭에서 각 거래의 부가세 열(과세/면세·영세/해당없음)을 바꾸면 여기에 바로 반영돼요. 신용카드·현금영수증 매입이나 세금계산서(홈택스) 자료는 별도라서, 실제 신고 전에 홈택스 자료와 꼭 대조하세요.</p>
    </div>
    <div class="panel" style="overflow-x:auto;">
      <table class="data-table"><thead><tr><th>신고 기간</th><th>신고·납부 기한</th><th>과세 매출(공급가액)</th><th>매출세액</th><th>과세 매입(공급가액)</th><th>매입세액</th><th>예상 납부(환급)세액</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="hint" style="margin-top:8px;">면세·영세 매출: ${cur.label} ${won(cur.sEx)}원 (세액 0원, 별도 신고 대상)</p>
    </div>
    <div class="panel" style="overflow-x:auto;">
      <h3>${cur.label} 집계 내역 (${cur.cnt}건)</h3>
      ${detail ? `<table class="data-table"><thead><tr><th>일자</th><th>구분</th><th>내용</th><th>분류</th><th>금액</th><th>공급가액</th><th>부가세</th></tr></thead><tbody>${detail}</tbody></table>` : `<div class="muted">이 기간에 집계된 과세·면세 거래가 없어요.</div>`}
    </div>`;
}

// 법인세 누진세율(2023년 이후 귀속분): 2억 이하 9%, 200억 이하 19%, 3,000억 이하 21%, 초과 24%
function bankCorpTax(base) {
  if (base <= 0) return 0;
  const brackets = [[200000000, 0.09], [20000000000, 0.19], [300000000000, 0.21], [Infinity, 0.24]];
  let tax = 0, prev = 0;
  for (const [limit, rate] of brackets) {
    if (base > prev) tax += (Math.min(base, limit) - prev) * rate;
    prev = limit;
  }
  return Math.floor(tax / 10) * 10;
}

function lastDayOfMonth(y, m) {
  return new Date(y, m, 0).getDate(); // m: 1~12
}
function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function taxBody(data, corp) {
  const txs = data.bankTx || [];
  const biz = data.bizTaxItems || [];
  const s = bankState;
  const today = todayStr();
  const years = [...new Set(txs.map((t) => Number(t.date.slice(0, 4))).concat(biz.map((b) => Number(b.payDate.slice(0, 4)))).concat([new Date().getFullYear()]))].sort().reverse();
  const y = s.taxYear;

  // --- 월별 손익 (부가세 과세 거래는 공급가액 기준) ---
  const monthly = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, inc: 0, exp: 0 }));
  const expByCat = {};
  txs.filter((t) => t.date.startsWith(String(y))).forEach((t) => {
    const c = bankCat(t.category);
    if (!c.pl) return;
    const idx = Number(t.date.slice(5, 7)) - 1;
    const amt = t.vat === "taxable" ? bankVatParts(t).supply : bankTxAmount(t);
    if (t.deposit > 0) monthly[idx].inc += amt;
    else { monthly[idx].exp += amt; expByCat[t.category] = (expByCat[t.category] || 0) + amt; }
  });
  const totInc = monthly.reduce((a, m) => a + m.inc, 0);
  const totExp = monthly.reduce((a, m) => a + m.exp, 0);
  const profit = totInc - totExp;
  const corpTax = bankCorpTax(profit);
  const localCorp = Math.floor((corpTax * 0.1) / 10) * 10;
  const plRows = monthly.map((m) => `<tr><td>${m.m}월</td><td class="num">${won(m.inc)}</td><td class="num">${won(m.exp)}</td><td class="num">${won(m.inc - m.exp)}</td></tr>`).join("");
  const catRows = Object.entries(expByCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${won(v)}</td><td class="num muted">${totExp ? Math.round((v / totExp) * 100) : 0}%</td></tr>`).join("");

  // --- 원천세(사업소득 3.3%) 연동 ---
  const byMonth = {};
  biz.filter((b) => b.payDate.startsWith(String(y))).forEach((b) => {
    const k = b.payDate.slice(0, 7);
    byMonth[k] = byMonth[k] || { gross: 0, tax: 0, n: 0 };
    byMonth[k].gross += Number(b.amount) || 0;
    byMonth[k].tax += Number(b.totalTax) || 0;
    byMonth[k].n++;
  });
  const whRows = Object.keys(byMonth).sort().map((k) => {
    const [yy, mm] = k.split(":")[0].split("-").map(Number);
    const dueY = mm === 12 ? yy + 1 : yy, dueM = mm === 12 ? 1 : mm + 1;
    const due = isoDate(dueY, dueM, 10);
    const paid = txs.filter((t) => t.withdraw > 0 && t.category === "원천세·세금공과" && t.date >= isoDate(dueY, dueM, 1) && t.date <= isoDate(dueY, dueM, lastDayOfMonth(dueY, dueM))).reduce((a, t) => a + t.withdraw, 0);
    const ok = paid >= byMonth[k].tax && byMonth[k].tax > 0;
    return `<tr><td>${k}</td><td class="num">${byMonth[k].n}건</td><td class="num">${won(byMonth[k].gross)}</td><td class="num"><strong>${won(byMonth[k].tax)}</strong></td><td>${due}</td><td class="num">${won(paid)}</td><td>${ok ? `<span class="tag tag-ok">납부 확인</span>` : due < today ? `<span class="tag tag-no">미확인</span>` : `<span class="tag">예정</span>`}</td></tr>`;
  }).join("");

  // --- 세금 일정 (앞으로 약 4개월) ---
  const events = [];
  const now = new Date();
  for (let i = -1; i <= 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const yy = d.getFullYear(), mm = d.getMonth() + 1;
    const prev = new Date(yy, mm - 2, 1);
    const pk = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    const allBiz = biz.filter((b) => b.payDate.startsWith(pk));
    const taxAmt = allBiz.reduce((a, b) => a + (Number(b.totalTax) || 0), 0);
    events.push({ date: isoDate(yy, mm, 10), title: `원천세 신고·납부 (${prev.getMonth() + 1}월 지급분)`, amount: allBiz.length ? taxAmt : null, note: "사업소득 3.3% 원천징수분" });
    events.push({ date: isoDate(yy, mm, lastDayOfMonth(yy, mm)), title: `사업소득 간이지급명세서 제출 (${prev.getMonth() + 1}월 지급분)`, amount: null, note: "홈택스, 미제출 시 가산세" });
  }
  [y - 1, y, y + 1].forEach((yy) => {
    bankVatSummary(txs, yy).forEach((p) => events.push({ date: p.dueDate, title: `부가세 ${p.label} (${yy}.${p.from}~${p.to})`, amount: p.cnt ? p.net : null, note: "은행 입출금 기준 추정" }));
  });
  const fyEnd = (() => { const m = String((corp && corp.fiscalYear) || "").match(/~\s*(\d+)월/); return m ? Number(m[1]) : 12; })();
  [y - 1, y].forEach((yy) => {
    const endM = fyEnd + 3 > 12 ? fyEnd + 3 - 12 : fyEnd + 3;
    const endY = fyEnd + 3 > 12 ? yy + 1 : yy;
    events.push({ date: isoDate(endY, endM, lastDayOfMonth(endY, endM)), title: `법인세 신고·납부 (${fyEnd}월 결산, ${yy}사업연도)`, amount: yy === y ? corpTax : null, note: "지방소득세는 그 달 말일까지 별도 신고(+10%)" });
  });
  const upcoming = events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
  const evRows = upcoming.map((e) => {
    const d = Math.round((new Date(e.date) - new Date(today)) / 86400000);
    return `<tr><td>${e.date}</td><td><span class="tag ${d <= 7 ? "tag-no" : d <= 30 ? "tag-wait" : ""}">D-${d}</span></td><td style="white-space:normal;">${esc(e.title)}<div class="muted" style="font-size:11.5px;">${esc(e.note)}</div></td><td class="num">${e.amount === null ? "-" : e.amount < 0 ? "환급 " + won(-e.amount) + "원" : won(e.amount) + "원"}</td></tr>`;
  }).join("");

  return `
    <div class="panel">
      <div class="filter-inline" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <select id="taxYearSel">${years.map((v) => `<option ${v === y ? "selected" : ""}>${v}</option>`).join("")}</select>
        <span class="muted">모든 금액은 참고용 추정치예요. 실제 신고는 세무사와 확인하세요.</span>
      </div>
    </div>
    <div class="panel" style="overflow-x:auto;">
      <h3>다가오는 세금 일정</h3>
      ${evRows ? `<table class="data-table"><thead><tr><th>기한</th><th>남은 일</th><th>내용</th><th>예상 금액</th></tr></thead><tbody>${evRows}</tbody></table>` : `<div class="muted">예정된 일정이 없어요.</div>`}
    </div>
    <div class="panel" style="overflow-x:auto;">
      <h3>원천세 (사업소득 신고내역 ↔ 은행 납부 대조)</h3>
      ${whRows ? `<table class="data-table"><thead><tr><th>지급월</th><th>인원</th><th>지급액(세전)</th><th>원천세 합계</th><th>납부기한</th><th>은행 납부 출금</th><th>상태</th></tr></thead><tbody>${whRows}</tbody></table>
      <p class="hint" style="margin-top:8px;">납부기한 달에 '원천세·세금공과'로 분류된 출금이 원천세 합계 이상이면 '납부 확인'으로 표시해요.</p>` : `<div class="muted">${y}년 사업소득 지급내역이 없어요.</div>`}
    </div>
    <div class="panel" style="overflow-x:auto;">
      <h3>${y}년 월별 손익 (부가세 제외 기준)</h3>
      <table class="data-table"><thead><tr><th>월</th><th>수입</th><th>비용</th><th>손익</th></tr></thead><tbody>${plRows}</tbody>
        <tfoot><tr><td>합계</td><td class="num">${won(totInc)}</td><td class="num">${won(totExp)}</td><td class="num">${won(profit)}</td></tr></tfoot></table>
      <p class="hint" style="margin-top:8px;">대출·출자·내부이체·부가세/법인세 납부 등 손익과 무관한 분류는 제외했어요.</p>
    </div>
    <div class="panel" style="overflow-x:auto;">
      <h3>비용 분류별 합계</h3>
      ${catRows ? `<table class="data-table"><thead><tr><th>분류</th><th>금액</th><th>비중</th></tr></thead><tbody>${catRows}</tbody></table>` : `<div class="muted">${y}년 비용 내역이 없어요.</div>`}
    </div>
    <div class="panel">
      <h3>법인세 대략 추정 (${y}년)</h3>
      <div class="tax-breakdown">
        <div>손익(과세표준 가정): <strong>${won(profit)}원</strong></div>
        <div>법인세: <strong>${won(corpTax)}원</strong> · 지방소득세(10%): <strong>${won(localCorp)}원</strong></div>
      </div>
      <p class="hint" style="margin-top:8px;">세율 2억 이하 9% / 200억 이하 19% 적용. 은행 입출금만으로 계산한 값이라 감가상각·미수/미지급·이월결손금·세액감면(창업중소기업 등)·세액공제는 반영되지 않았어요.</p>
    </div>`;
}

function bankSubBody(sub, data, corp) {
  if (sub === "bank") return bankBody(data);
  if (sub === "vat") return vatBody(data);
  if (sub === "tax") return taxBody(data, corp);
  return "";
}

// ---------- 이벤트 ----------
async function bankSave(mut) {
  const d = await loadModule("accounting");
  d.bankTx = d.bankTx || [];
  mut(d);
  await saveModule("accounting", d);
  refreshCurrentTab();
}

function bindBank() {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  $("#bankMonthFilter")?.addEventListener("change", (e) => { bankState.month = e.target.value; refreshCurrentTab(); });
  $("#bankDirFilter")?.addEventListener("change", (e) => { bankState.dir = e.target.value; refreshCurrentTab(); });
  $("#bankCatFilter")?.addEventListener("change", (e) => { bankState.cat = e.target.value; refreshCurrentTab(); });
  $("#vatYearSel")?.addEventListener("change", (e) => { bankState.vatYear = Number(e.target.value); bankState.vatPeriod = ""; refreshCurrentTab(); });
  $("#taxYearSel")?.addEventListener("change", (e) => { bankState.taxYear = Number(e.target.value); refreshCurrentTab(); });
  $$("[data-vat-period]").forEach((tr) => tr.addEventListener("click", () => { bankState.vatPeriod = tr.dataset.vatPeriod; refreshCurrentTab(); }));

  $$("[data-bank-cat]").forEach((s) =>
    s.addEventListener("change", () =>
      bankSave((d) => {
        const t = d.bankTx.find((x) => x.id === s.dataset.bankCat);
        if (t) { t.category = s.value; t.vat = bankCat(s.value).vat; }
      })
    )
  );
  $$("[data-bank-vat]").forEach((s) =>
    s.addEventListener("change", () => bankSave((d) => { const t = d.bankTx.find((x) => x.id === s.dataset.bankVat); if (t) t.vat = s.value; }))
  );
  $$("[data-bank-del]").forEach((b) =>
    b.addEventListener("click", () => bankSave((d) => { d.bankTx = d.bankTx.filter((x) => x.id !== b.dataset.bankDel); }))
  );
  $("#bankClearBtn")?.addEventListener("click", async () => {
    if (!confirm("등록된 은행 거래내역을 모두 삭제할까요? (사업소득 신고내역은 그대로 유지돼요)")) return;
    bankSave((d) => { d.bankTx = []; });
  });

  $("#bankAddBtn")?.addEventListener("click", () => {
    openModal(bankManualForm());
    $("#bankManualSaveBtn").addEventListener("click", async () => {
      const amount = Number($("#bm_amount").value) || 0;
      const date = $("#bm_date").value;
      if (!amount || !date) { alert("일자와 금액을 입력해주세요."); return; }
      const isIn = $("#bm_dir").value === "in";
      const d0 = await loadModule("accounting");
      const names = (d0.bizTaxItems || []).map((b) => b.name);
      const tx = { id: uid(), date, time: "", desc: $("#bm_desc").value.trim(), counterparty: $("#bm_cp").value.trim(), memo: "", deposit: isIn ? amount : 0, withdraw: isIn ? 0 : amount, balance: 0, source: "manual" };
      tx.category = bankGuessCategory(tx, names);
      tx.vat = bankCat(tx.category).vat;
      closeModal();
      bankSave((d) => { d.bankTx.push(tx); });
    });
  });

  const fileInput = $("#bankFileInput");
  $("#bankUploadBtn")?.addEventListener("click", () => fileInput.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const btn = $("#bankUploadBtn");
    const orig = btn.textContent;
    btn.textContent = "파일 읽는 중...";
    btn.disabled = true;
    try {
      const rows = await bankReadFile(file);
      if (!rows.length) { alert("거래내역을 찾지 못했어요. 기업은행 거래내역 엑셀/CSV가 맞는지, 머리글(거래일, 입금, 출금 등)이 있는지 확인해주세요."); return; }
      const d = await loadModule("accounting");
      const have = new Set((d.bankTx || []).map(bankTxKey));
      const names = (d.bizTaxItems || []).map((b) => b.name);
      let dup = 0;
      rows.forEach((r) => {
        r.category = bankGuessCategory(r, names);
        r._dup = have.has(bankTxKey(r));
        if (r._dup) dup++;
      });
      openModal(bankImportReviewForm(rows, dup), { wide: true });
      $("#bankImportConfirmBtn").addEventListener("click", async () => {
        const picked = [];
        rows.forEach((r, i) => {
          const chk = document.querySelector(`[data-imp-chk="${i}"]`);
          if (chk && chk.checked) {
            const cat = document.querySelector(`[data-imp-cat="${i}"]`).value;
            picked.push({ id: uid(), date: r.date, time: r.time, desc: r.desc, counterparty: r.counterparty, memo: r.memo, deposit: r.deposit, withdraw: r.withdraw, balance: r.balance, category: cat, vat: bankCat(cat).vat, source: "import" });
          }
        });
        if (!picked.length) { alert("등록할 항목을 선택해주세요."); return; }
        closeModal();
        bankSave((dd) => {
          const keys = new Set(dd.bankTx.map(bankTxKey));
          picked.forEach((p) => { if (!keys.has(bankTxKey(p))) { dd.bankTx.push(p); keys.add(bankTxKey(p)); } });
        });
      });
    } catch (err) {
      console.error(err);
      alert("파일을 읽는 중 오류가 발생했어요. (" + err.message + ")");
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
      fileInput.value = "";
    }
  });
}
