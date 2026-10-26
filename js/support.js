// support.js — "지원사업·정책" 탭에서 쓰는 지원사업 카탈로그와 자격(해당 여부) 판정 로직
//
// 정부 지원사업은 매년 공고가 새로 나오고 금액·요건이 조금씩 바뀌어요. 그래서 여기엔
// "매년 반복되는 대표 사업"의 골격(대상·지원내용·보통 공고 시기·공식 링크)만 담아두고,
// 실제 신청 전에는 반드시 카드의 "최신 공고 검색"/"공식 사이트"로 올해 공고문을 확인하는 방식이에요.
// (내용 기준: 2026년 중앙부처·지자체 창업지원사업 통합공고 및 각 기관 안내)
//
// rule 필드로 우리 회사 프로필(업력/대표 나이/근로자 수 등)과 비교해 해당 여부를 자동 표시해요.
//   preFounding: 법인(사업자) 설립 전 예비창업자 대상
//   minYears / maxYears: 업력(설립일 기준 경과 연수) 초과 / 이내
//   maxCeoAge: 대표자 만 나이 상한
//   minEmployees / maxEmployees: 상시근로자(고용보험 피보험자) 수 하한 / 상한
//   doneFlag: 프로필에서 이미 갖춘 항목(예: 벤처인증)이면 "보유 중"으로 표시
//   region: 해당 지역 소재 기업만 대상 (예: "gwangju" — 프로필의 본사 소재지와 비교)
//   needs: 자동으로 판단할 수 없어 직접 확인해야 하는 조건들

const SUPPORT_CATEGORIES = [
  { key: "fund", label: "사업화 자금" },
  { key: "rnd", label: "투자·R&D" },
  { key: "loan", label: "정책자금·보증" },
  { key: "hire", label: "고용·인건비" },
  { key: "tax", label: "세제·인증" },
  { key: "content", label: "콘텐츠·AI 특화" },
  { key: "space", label: "공간·바우처·기타" },
  { key: "gwangju", label: "광주 지역" },
];

// 프로필 "본사 소재지" 선택지. 창업중소기업 세액감면 계산에 쓰는 권역(metro_dense/metro/local)과
// 지역 전용 사업 판정(gwangju)을 함께 담아요. 광주는 비수도권이라 세액감면에선 local과 같게 봐요.
const SUPPORT_REGIONS = [
  { key: "gwangju", label: "광주 (전남광주통합특별시, 비수도권)" },
  { key: "local", label: "그 외 비수도권" },
  { key: "metro", label: "수도권 (과밀억제권역 외)" },
  { key: "metro_dense", label: "수도권 과밀억제권역 (서울 전역, 인천·경기 일부)" },
];

const SUPPORT_STATUSES = ["관심", "준비중", "신청완료", "선정", "탈락"];

// 실시간 공고를 직접 볼 수 있는 공식 포털 바로가기
const SUPPORT_PORTALS = [
  { name: "K-Startup 사업공고", desc: "중기부·창업진흥원 창업지원사업 공고", link: "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do" },
  { name: "기업마당", desc: "부처·지자체 중소기업 지원사업 통합 공고", link: "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/list.do" },
  { name: "중소벤처기업진흥공단", desc: "정책자금 융자·청년창업사관학교", link: "https://www.kosmes.or.kr/" },
  { name: "한국콘텐츠진흥원", desc: "콘텐츠 스타트업·제작 지원 공고", link: "https://www.kocca.kr/" },
  { name: "고용24", desc: "고용장려금·청년 채용 지원 신청", link: "https://www.work24.go.kr/" },
  { name: "기술보증기금", desc: "청년창업·기술 보증", link: "https://www.kibo.or.kr/" },
  { name: "신용보증기금", desc: "창업기업 보증", link: "https://www.kodit.or.kr/" },
  { name: "SMTECH", desc: "중소기업 R&D(디딤돌 등) 공고", link: "https://www.smtech.go.kr/" },
];

// 광주 지역 공고 포털 (본사 소재지가 광주일 때 따로 묶어서 보여줘요)
const SUPPORT_PORTALS_GWANGJU = [
  { name: "광주 기업지원 통합공고", desc: "광주 기업지원 사업 공고 모아보기", link: "https://www.gjbizinfo.or.kr/" },
  { name: "광주 창업 플랫폼", desc: "광주 창업지원 사업·프로그램", link: "https://gwangju-startup.kr/home" },
  { name: "전남광주 청년통합플랫폼", desc: "청년 창업·일자리·주거 정책", link: "https://youth.jeonnam-gwangju.go.kr/www/" },
  { name: "광주테크노파크 사업공고", desc: "창업·제조·청년창업 거주시설 공고", link: "https://www.gjtp.or.kr/home/business.cs" },
  { name: "광주정보문화산업진흥원", desc: "콘텐츠코리아랩·지역 콘텐츠기업 지원", link: "https://www.gicon.or.kr/" },
  { name: "인공지능산업융합사업단", desc: "광주 AI 창업캠프·실증 지원", link: "https://www.aica-gj.kr/" },
  { name: "광주창조경제혁신센터", desc: "보육·투자 연계 프로그램", link: "https://ccei.creativekorea.or.kr/gwangju/" },
  { name: "광주신용보증재단", desc: "소기업·소상공인 특례보증", link: "https://www.gjsinbo.or.kr/" },
];

const SUPPORT_CATALOG = [
  // ---------- 사업화 자금 ----------
  {
    id: "pre_pkg",
    name: "예비창업패키지",
    org: "중소벤처기업부 · 창업진흥원",
    cat: "fund",
    summary: "혁신 아이디어를 가진 예비창업자의 창업 사업화 지원",
    benefit: "사업화 자금(평균 수천만 원~최대 1억 원 내외) + 창업 교육·멘토링",
    target: "공고일 기준 사업자(법인) 등록이 없는 예비창업자",
    period: "보통 연초(2~3월) 공고 · 2027년부터 '모두의창업'으로 통합 예정 보도",
    link: "https://www.k-startup.go.kr/",
    rule: { preFounding: true },
  },
  {
    id: "early_pkg",
    name: "초기창업패키지",
    org: "중소벤처기업부 · 창업진흥원",
    cat: "fund",
    summary: "업력 3년 이내 초기 창업기업의 제품·서비스 고도화와 시장 진입 지원",
    benefit: "사업화 자금(최대 1억 원 내외) + 주관기관 특화 프로그램(투자연계·실증 등)",
    target: "업력 3년 이내 창업기업",
    period: "보통 연초(2~3월) 공고",
    link: "https://www.k-startup.go.kr/",
    rule: { maxYears: 3 },
  },
  {
    id: "leap_pkg",
    name: "창업도약패키지",
    org: "중소벤처기업부 · 창업진흥원",
    cat: "fund",
    summary: "데스밸리를 넘는 도약기 기업의 스케일업 지원",
    benefit: "사업화 자금(최대 수억 원 규모) + 투자·판로·글로벌 프로그램",
    target: "업력 3년 초과 7년 이내 창업기업",
    period: "보통 연초(2~3월) 공고",
    link: "https://www.k-startup.go.kr/",
    rule: { minYears: 3, maxYears: 7 },
  },
  {
    id: "youth_academy",
    name: "청년창업사관학교",
    org: "중소벤처기업부 · 중소벤처기업진흥공단",
    cat: "fund",
    summary: "청년 창업자 대상 사업화 자금 + 입주공간 + 코칭을 묶은 패키지",
    benefit: "사업화 자금(최대 1억 원 내외), 사무공간, 전담 코칭, 후속 정책자금 연계",
    target: "대표자 만 39세 이하 · 업력 3년 이내(예비창업자 포함)",
    period: "보통 연초(1~2월) 공고",
    link: "https://start.kosmes.or.kr/",
    rule: { maxYears: 3, maxCeoAge: 39 },
  },
  {
    id: "startup_univ",
    name: "창업중심대학",
    org: "중소벤처기업부 · 창업진흥원(대학 주관)",
    cat: "fund",
    summary: "지역 거점 대학이 주관하는 단계별(예비·초기·도약) 사업화 지원",
    benefit: "단계별 사업화 자금 + 대학 인프라·멘토링",
    target: "예비창업자 및 업력 7년 이내 창업기업 (단계별 요건 상이)",
    period: "보통 연초 공고 · 주관 대학별 모집",
    link: "https://www.k-startup.go.kr/",
    rule: { maxYears: 7 },
  },

  // ---------- 투자·R&D ----------
  {
    id: "tips",
    name: "TIPS (민간투자주도형 기술창업지원)",
    org: "중소벤처기업부 · 한국엔젤투자협회",
    cat: "rnd",
    summary: "TIPS 운영사(VC·AC)가 먼저 투자하면 정부가 R&D·사업화 자금을 매칭",
    benefit: "R&D 자금(일반 최대 5억 원 내외, 최대 2~3년) + 창업사업화·해외마케팅 추가 연계",
    target: "업력 7년 이내 기술창업기업 · TIPS 운영사 투자 유치(추천) 필수",
    period: "상시 접수(운영사 추천)",
    link: "https://www.jointips.or.kr/",
    rule: { maxYears: 7, needs: ["TIPS 운영사 투자 유치·추천"] },
  },
  {
    id: "didimdol",
    name: "디딤돌 창업과제 (창업성장기술개발)",
    org: "중소벤처기업부",
    cat: "rnd",
    summary: "창업기업의 첫 기술개발(R&D) 과제 지원",
    benefit: "R&D 자금(최대 1억 원 대, 1년 내외)",
    target: "업력 7년 이내 · 직전년도 매출 20억 원 미만 창업기업 (기업부설연구소 등 요건 확인)",
    period: "보통 상반기 공고",
    link: "https://www.smtech.go.kr/",
    rule: { maxYears: 7, needs: ["매출 20억 원 미만", "연구소/연구전담부서 보유 여부"] },
  },

  // ---------- 정책자금·보증 ----------
  {
    id: "youth_loan",
    name: "청년전용창업자금",
    org: "중소벤처기업진흥공단",
    cat: "loan",
    summary: "청년 창업기업 전용 저금리 정책자금 융자 + 경영 멘토링",
    benefit: "최대 1억 원 내외 융자 · 고정 저금리(연 2%대) · 5~6년 상환",
    target: "대표자 만 39세 이하 · 업력 3년 미만",
    period: "연중 접수(월별 신청, 예산 소진 시 마감)",
    link: "https://www.kosmes.or.kr/",
    rule: { maxYears: 3, maxCeoAge: 39 },
  },
  {
    id: "startup_loan",
    name: "혁신창업사업화자금 (창업기반지원)",
    org: "중소벤처기업진흥공단",
    cat: "loan",
    summary: "창업기업의 시설·운전 자금 정책융자",
    benefit: "운전자금·시설자금 저금리 융자 (한도·금리는 연도별 공고)",
    target: "업력 7년 미만 중소기업",
    period: "연중 접수(월별 신청)",
    link: "https://www.kosmes.or.kr/",
    rule: { maxYears: 7 },
  },
  {
    id: "kibo_youth",
    name: "청년창업기업 우대보증",
    org: "기술보증기금",
    cat: "loan",
    summary: "청년 기술창업기업의 은행 대출에 높은 보증비율·보증료 감면 제공",
    benefit: "보증한도·보증비율 우대(최대 95~100%), 보증료 감면",
    target: "대표자 만 39세 이하 · 업력 7년 이내 기술창업기업",
    period: "상시",
    link: "https://www.kibo.or.kr/",
    rule: { maxYears: 7, maxCeoAge: 39 },
  },
  {
    id: "kodit_startup",
    name: "창업기업 보증 (스타트업 보증 프로그램)",
    org: "신용보증기금",
    cat: "loan",
    summary: "창업 초기 기업의 금융기관 대출 보증 (퍼스트펭귄 등 유망 창업기업 프로그램 포함)",
    benefit: "창업기업 전용 보증·보증료 감면, 유망기업은 보증한도 확대",
    target: "업력 7년 이내 창업기업 (프로그램별 요건 상이)",
    period: "상시",
    link: "https://www.kodit.or.kr/",
    rule: { maxYears: 7 },
  },
  {
    id: "culture_guarantee",
    name: "문화산업(콘텐츠) 보증",
    org: "기술보증기금 · 문화체육관광부",
    cat: "loan",
    summary: "콘텐츠 제작 계약·IP 가치를 근거로 제작 자금 대출을 보증",
    benefit: "제작 자금 대출 보증, 보증비율·보증료 우대",
    target: "영상·게임·웹툰 등 콘텐츠 제작 기업 (제작/유통 계약 등 확인)",
    period: "상시",
    link: "https://www.kibo.or.kr/",
    rule: { needs: ["콘텐츠 제작·유통 계약 또는 IP 보유"] },
  },

  // ---------- 고용·인건비 ----------
  {
    id: "youth_job_leap",
    name: "청년일자리도약장려금",
    org: "고용노동부",
    cat: "hire",
    summary: "청년을 정규직으로 채용해 6개월 이상 고용 유지하면 인건비 지원 (2026년 수도권·비수도권 유형 개편)",
    benefit: "기업: 청년 1인당 1년간 최대 720만 원 · 청년: 근속 시 별도 지원(비수도권 우대)",
    target: "고용보험 피보험자 5인 이상 우선지원대상기업 · 만 15~34세 청년 정규직 신규채용",
    period: "연중(지역 운영기관별 참여기업 모집, 예산 소진 시 마감)",
    link: "https://www.work24.go.kr/",
    rule: { minEmployees: 5, needs: ["채용할 청년의 취업애로 요건 등"] },
    note: (p) => (p.region === "gwangju" || p.region === "local" ? "비수도권 유형 해당 — 지방 소재 기업 우대(청년 근속 지원도 비수도권 우대)" : ""),
  },
  {
    id: "durunuri",
    name: "두루누리 사회보험료 지원",
    org: "고용노동부 · 보건복지부",
    cat: "hire",
    summary: "소규모 사업장 신규 가입 근로자의 고용보험·국민연금 보험료 일부 지원",
    benefit: "사업주·근로자 부담분 고용보험·국민연금 보험료의 80% 지원(최대 36개월)",
    target: "근로자 10명 미만 사업장 · 월평균보수 기준 이하 신규 가입 근로자",
    period: "상시 (4대보험 가입 신고 시 신청)",
    link: "https://insurancesupport.or.kr/",
    rule: { maxEmployees: 9 },
  },
  {
    id: "employment_tax",
    name: "통합고용세액공제",
    org: "국세청 (조세특례제한법)",
    cat: "hire",
    summary: "전년 대비 상시근로자 수가 늘면 증가 인원 1인당 법인세에서 공제",
    benefit: "중소기업 청년 등 1인당 연 최대 1,450만 원(수도권)~1,550만 원(지방), 3년간 공제",
    target: "상시근로자 수가 전년보다 증가한 중소기업",
    period: "법인세 신고 시(매년 3월) 적용",
    link: "https://www.hometax.go.kr/",
    rule: { needs: ["전년 대비 상시근로자 증가"] },
  },

  // ---------- 세제·인증 ----------
  {
    id: "startup_tax_cut",
    name: "창업중소기업 세액감면",
    org: "국세청 (조세특례제한법 제6조)",
    cat: "tax",
    summary: "창업 후 5년간 법인세(소득세) 감면",
    benefit: "청년창업(대표 만 34세 이하): 수도권과밀억제권역 외 100% · 내 50% / 그 외: 과밀억제권역 외 50%",
    target: "창업 후 5년 이내 · 감면 대상 업종 (정보통신업·콘텐츠 제작 등 포함 여부 확인)",
    period: "법인세 신고 시(매년 3월) 적용",
    link: "https://www.hometax.go.kr/",
    rule: { maxYears: 5, needs: ["감면 대상 업종 여부"] },
    note: (p) => {
      const age = supportCeoAge(p);
      if (age == null) return "대표자 생년월일을 입력하면 감면율을 계산해드려요.";
      const youth = age <= 34;
      if (p.region === "metro_dense") return youth ? "청년창업 · 과밀억제권역 내 → 50% 감면 예상" : "과밀억제권역 내 일반 창업 → 감면 없음(벤처 등 별도 요건 확인)";
      if (p.region === "metro" || p.region === "local" || p.region === "gwangju") return youth ? "청년창업 · 과밀억제권역 외 → 100% 감면 예상" : "과밀억제권역 외 일반 창업 → 50% 감면 예상";
      return youth ? "청년창업 대상 (지역에 따라 50~100%)" : "지역에 따라 0~50%";
    },
  },
  {
    id: "venture_cert",
    name: "벤처기업 확인",
    org: "중소벤처기업부 · 벤처기업확인기관",
    cat: "tax",
    summary: "벤처기업으로 확인받으면 세제·금융·인력 혜택",
    benefit: "창업 3년 내 확인 시 법인세 감면, 취득세·재산세 감면, 정책자금·보증 우대, 스톡옵션 특례 등",
    target: "투자 유치·연구개발·혁신성장 유형 중 하나 충족",
    period: "상시",
    link: "https://www.smes.go.kr/venturein/",
    rule: { doneFlag: "isVenture", needs: ["투자/R&D/혁신성장 유형 요건"] },
  },
  {
    id: "rnd_lab",
    name: "기업부설연구소 · 연구개발전담부서 인정",
    org: "한국산업기술진흥협회(KOITA)",
    cat: "tax",
    summary: "연구 전담 인력·공간을 갖추면 인정받아 R&D 세제 혜택",
    benefit: "연구·인력개발비 세액공제(중소기업 25%), R&D 과제 가점, 병역특례 요건 등",
    target: "연구전담요원(학력·경력 요건) + 독립된 연구공간 보유 기업",
    period: "상시",
    link: "https://www.rnd.or.kr/",
    rule: { doneFlag: "hasLab", needs: ["연구전담요원·연구공간"] },
  },
  {
    id: "startup_confirm",
    name: "창업기업 확인서",
    org: "중소벤처기업부",
    cat: "tax",
    summary: "창업기업임을 공식 확인받아 공공구매·지원사업 우대에 활용",
    benefit: "공공기관 창업기업 제품 우선구매·제한경쟁 입찰 참여 등",
    target: "업력 7년 이내 창업기업",
    period: "상시",
    link: "https://www.k-startup.go.kr/",
    rule: { maxYears: 7 },
  },

  // ---------- 콘텐츠·AI 특화 ----------
  {
    id: "kocca_startup",
    name: "콘텐츠 스타트업 지원 (투자연계 창업도약·액셀러레이터 연계 등)",
    org: "문화체육관광부 · 한국콘텐츠진흥원",
    cat: "content",
    summary: "콘텐츠 스타트업 대상 사업화 자금 + 액셀러레이팅·투자 연계 (트랙별 모집)",
    benefit: "트랙별 사업화 자금(수천만 원~최대 1.8억 원 내외) + 투자·멘토링",
    target: "업력 7년 이내 콘텐츠 스타트업 (트랙별 투자유치 등 요건 상이)",
    period: "보통 3~4월 공고",
    link: "https://www.kocca.kr/",
    rule: { maxYears: 7 },
  },
  {
    id: "kocca_openinno",
    name: "콘텐츠 오픈이노베이션 · 글로벌 진출(론치패드)",
    org: "한국콘텐츠진흥원",
    cat: "content",
    summary: "대기업 파트너와 협업(PoC) 또는 해외 진출 액셀러레이팅",
    benefit: "협업 프로젝트 자금·실증 기회, 해외 IR·네트워킹",
    target: "콘텐츠 스타트업 (오픈이노베이션은 업력 3~7년 중심, 트랙별 상이)",
    period: "보통 3~6월 공고",
    link: "https://www.kocca.kr/",
    rule: { maxYears: 7 },
  },
  {
    id: "ai_voucher",
    name: "AI 바우처",
    org: "과학기술정보통신부 · 정보통신산업진흥원(NIPA)",
    cat: "content",
    summary: "AI 솔루션 도입이 필요한 기업(수요기업)에 AI 공급기업 솔루션 구매 바우처 지원",
    benefit: "과제당 수천만 원~최대 수억 원 규모 바우처 (공급기업으로도 참여 가능)",
    target: "AI 솔루션 도입을 원하는 중소·벤처기업 (또는 AI 공급기업)",
    period: "보통 상반기 공고",
    link: "https://www.nipa.kr/",
    rule: {},
  },
  {
    id: "data_voucher",
    name: "데이터바우처",
    org: "과학기술정보통신부 · 한국데이터산업진흥원",
    cat: "content",
    summary: "AI 학습·서비스 개발에 필요한 데이터 구매·가공 비용을 바우처로 지원",
    benefit: "데이터 구매·가공(AI 가공 포함) 바우처",
    target: "데이터가 필요한 중소기업·스타트업",
    period: "보통 연초 공고",
    link: "https://www.kdata.or.kr/",
    rule: {},
  },

  // ---------- 공간·바우처·기타 ----------
  {
    id: "export_voucher",
    name: "수출바우처",
    org: "산업통상자원부 · 중소벤처기업부",
    cat: "space",
    summary: "해외 진출에 필요한 번역·마케팅·인증 등 서비스를 바우처로 구매",
    benefit: "수출 규모별 바우처(자부담 일부) — 해외 홍보·현지화·콘텐츠 번역 등에 활용",
    target: "수출 실적 또는 수출 계획이 있는 중소기업 (내수기업 트랙 포함)",
    period: "보통 연초 공고(추가 모집 있음)",
    link: "https://www.exportvoucher.com/",
    rule: { needs: ["수출 실적/계획"] },
  },
  {
    id: "incubator",
    name: "창업보육센터 · 지자체 창업공간 입주",
    org: "중소벤처기업부 · 각 지자체(서울창업허브 등)",
    cat: "space",
    summary: "저렴한 사무공간 + 보육 프로그램 (지자체·대학별 모집)",
    benefit: "사무공간(무상~저가), 회의실·장비, 투자·멘토링 연계",
    target: "보통 업력 3~7년 이내 창업기업 (기관별 상이)",
    period: "기관별 수시 모집",
    link: "https://www.bizinfo.go.kr/",
    rule: { maxYears: 7 },
  },
  {
    id: "local_support",
    name: "지자체 창업·청년기업 지원사업",
    org: "광역·기초 지자체 (통합공고 기준 400여 개 사업)",
    cat: "space",
    summary: "본사 소재지 지자체가 운영하는 창업자금·청년기업 지원·마케팅 지원 등",
    benefit: "지자체별 사업화 자금, 이자 지원, 홍보·판로 지원 등",
    target: "해당 지자체 소재 기업 (청년 대표·업력 요건은 사업별 상이)",
    period: "연중(지자체별)",
    link: "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/list.do",
    rule: { needs: ["본사 소재지"] },
  },

  // ---------- 광주 지역 (본사 소재지가 광주인 기업 대상) ----------
  // 2026년 광주·전남 행정통합으로 "전남광주통합특별시" 명의로 나오는 공고도 있어요.
  {
    id: "gj_youth_academy",
    name: "전남광주 청년창업 사관학교",
    org: "전남광주통합특별시",
    cat: "gwangju",
    summary: "청년 창업자를 선발해 2년간 맞춤형 보육 — 광역지자체가 기술사업화 자금을 직접 지원 (2026년 2기부터 광주 권역까지 확대)",
    benefit: "월 100만 원 바우처 + 기술사업화 자금 + 2년간 보육·멘토링 (2026년 2기 121명 선발)",
    target: "만 18~45세 예비창업자 및 창업 5년 이내 초기 창업자",
    period: "연 1회 기수 모집 (2026년 2기 출범)",
    link: "https://youth.jeonnam-gwangju.go.kr/www/",
    rule: { region: "gwangju", maxYears: 5, maxCeoAge: 45 },
  },
  {
    id: "gj_content_lab",
    name: "광주콘텐츠코리아랩 콘텐츠 창·제작 지원",
    org: "광주정보문화산업진흥원(GICON)",
    cat: "gwangju",
    summary: "콘텐츠 IP 창작자·초기 콘텐츠 기업의 단계별(주니어→부스터) 창·제작 지원",
    benefit: "단계별 창·제작 지원금 + 멘토링·제작 인프라 (웹툰·웹애니·실감영상 등 IP 분야)",
    target: "예비창업자 및 창업 3년 미만 기업 (단계별 요건 상이)",
    period: "보통 3~4월 공고 (추가 모집 있음)",
    link: "https://www.gicon.or.kr/",
    rule: { region: "gwangju", maxYears: 3 },
  },
  {
    id: "gj_content_biz",
    name: "광주 지역 콘텐츠기업 지원 (GICON)",
    org: "광주정보문화산업진흥원(GICON)",
    cat: "gwangju",
    summary: "광주 소재 콘텐츠기업 대상 여러 단발성 지원 — 투자진흥지구 보증료·출원료, 문화콘텐츠 SW 라이선스 사용료, 콘텐츠 IP 지역특화 상품개발, IR DAY 등",
    benefit: "보증료·출원료 기업당 최대 500만 원 이내, SW 라이선스 사용료, 상품개발 과제비, IR 컨설팅·시상금 등",
    target: "광주 소재 콘텐츠기업 (사업별 요건 상이)",
    period: "연중 수시 (2026년 기준 5~10월에 여러 건 공고)",
    link: "https://www.gicon.or.kr/",
    rule: { region: "gwangju", needs: ["사업별 세부 요건"] },
  },
  {
    id: "gj_aica",
    name: "광주 AI 창업 지원 (AI창업캠프·실증)",
    org: "인공지능산업융합사업단(AICA) · 광주광역시",
    cat: "gwangju",
    summary: "국가 AI 융복합단지(2단계 2025~2029)의 AI 스타트업 지원 — 창업캠프 입주, AI 데이터센터 컴퓨팅 자원·실증, 시제품 제작 지원",
    benefit: "AI창업캠프 입주공간, 컴퓨팅 자원·실증 인프라, 시제품·서비스 제작 지원(과거 최대 1억 원 규모) 등",
    target: "광주 소재(또는 이전 예정) AI 관련 창업기업",
    period: "수시 (입주기업은 차수별 모집)",
    link: "https://www.aica-gj.kr/",
    rule: { region: "gwangju", needs: ["AI 관련 사업 여부"] },
  },
  {
    id: "gj_tp",
    name: "광주테크노파크 창업기업 지원",
    org: "광주테크노파크",
    cat: "gwangju",
    summary: "제조 창업기업 시제품 개발 원스톱 지원, 청년창업 거주지원시설(창업하여家) 입주 등",
    benefit: "시제품 개발 기업당 최대 700만 원 내외, 청년 창업자 거주·업무 공간 등",
    target: "광주 소재 업력 7년 이내 창업기업 (신산업 분야 10년 이내, 사업별 상이)",
    period: "보통 4~9월 공고",
    link: "https://www.gjtp.or.kr/home/business.cs",
    rule: { region: "gwangju", maxYears: 7, needs: ["제조·신산업 분야 등 사업별 요건"] },
  },
  {
    id: "gj_sinbo",
    name: "광주 소기업·소상공인 특례보증 + 이차보전",
    org: "광주신용보증재단 · 전남광주통합특별시",
    cat: "gwangju",
    summary: "광주 사업장 소기업·소상공인의 은행 대출을 재단이 보증하고, 시가 이자 일부를 지원 (청년창업 특례보증 별도 공고 있음)",
    benefit: "업체당 최대 5,000만 원 보증 + 1년간 연 3~4% 이차보전 (2026년 하반기 기준)",
    target: "광주 소재 소기업·소상공인 (일부 제한 업종 제외)",
    period: "예산 소진 시까지 (상·하반기)",
    link: "https://www.gjsinbo.or.kr/",
    rule: { region: "gwangju", needs: ["소기업·소상공인 기준"] },
  },
  {
    id: "gj_ccei",
    name: "광주창조경제혁신센터 · 광주 청년 창업 성장 지원",
    org: "광주창조경제혁신센터 · 광주광역시",
    cat: "gwangju",
    summary: "광주 청년 창업기업 대상 액셀러레이터 매칭, 창업 성장 육성 프로젝트, 투자 연계 보육 프로그램",
    benefit: "전문 액셀러레이팅, 사업화 지원금, IR·투자 연계 (프로그램별 상이)",
    target: "광주 소재 예비·초기 창업기업 (청년 대상 프로그램 다수)",
    period: "연중 (프로그램별 수시 모집)",
    link: "https://ccei.creativekorea.or.kr/gwangju/",
    rule: { region: "gwangju", needs: ["프로그램별 요건"] },
  },
];

// "2024-03-05", "2024. 3. 5.", "2024년 3월 5일" 같은 형식을 모두 Date로 바꿔요.
function supportParseDate(s) {
  const m = String(s || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d) ? null : d;
}

// 업력: 설립일부터 오늘까지 경과한 연수 (소수점 — 예: 2.4년)
function supportBizYears(foundedDate) {
  const d = supportParseDate(foundedDate);
  if (!d) return null;
  return (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
}

// 대표자 만 나이
function supportCeoAge(p) {
  const b = supportParseDate(p && p.ceoBirth);
  if (!b) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

function supportFormatYears(y) {
  if (y == null) return "";
  const totalMonths = Math.floor(y * 12);
  return `${Math.floor(totalMonths / 12)}년 ${totalMonths % 12}개월`;
}

// 프로필과 rule을 비교해 { level, reasons } 를 돌려줘요.
//   level: "ok"(해당) | "check"(확인 필요) | "no"(대상 아님) | "done"(이미 보유)
function supportEvaluate(rule, profile, foundedDate) {
  rule = rule || {};
  const p = profile || {};
  const no = [];
  const check = [];
  const years = supportBizYears(foundedDate);
  const age = supportCeoAge(p);
  const emp = p.employees === "" || p.employees == null ? null : Number(p.employees);

  if (rule.doneFlag && p[rule.doneFlag]) return { level: "done", reasons: ["이미 보유 중"] };

  if (rule.region) {
    if (!p.region) check.push("본사 소재지 입력 필요");
    else if (p.region !== rule.region) no.push("지역 전용 사업 (본사 소재지 다름)");
  }
  if (rule.preFounding) {
    if (years != null) no.push("이미 설립된 기업 (예비창업자 대상)");
  }
  if (rule.maxYears != null || rule.minYears != null) {
    if (years == null) check.push("법인정보에 설립일 입력 필요");
    else {
      if (rule.maxYears != null && years > rule.maxYears) no.push(`업력 ${rule.maxYears}년 초과`);
      if (rule.minYears != null && years <= rule.minYears) no.push(`업력 ${rule.minYears}년 이하 (${rule.minYears}년 초과 대상)`);
    }
  }
  if (rule.maxCeoAge != null) {
    if (age == null) check.push("대표자 생년월일 입력 필요");
    else if (age > rule.maxCeoAge) no.push(`대표자 만 ${rule.maxCeoAge}세 초과`);
  }
  if (rule.minEmployees != null || rule.maxEmployees != null) {
    if (emp == null || isNaN(emp)) check.push("상시근로자 수 입력 필요");
    else {
      if (rule.minEmployees != null && emp < rule.minEmployees) no.push(`근로자 ${rule.minEmployees}인 미만`);
      if (rule.maxEmployees != null && emp > rule.maxEmployees) no.push(`근로자 ${rule.maxEmployees + 1}인 이상`);
    }
  }
  (rule.needs || []).forEach((n) => check.push(n + " 확인"));

  if (no.length) return { level: "no", reasons: no };
  if (check.length) return { level: "check", reasons: check };
  return { level: "ok", reasons: ["기본 요건 충족"] };
}
