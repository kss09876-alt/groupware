// Drive.js — Google 인증 + 구글 드라이브를 "DB"처럼 쓰기 위한 헬퍼
// 저장 방식: 회사 데이터 폴더(폴더ID는 localStorage에 저장) 안에
// notices.json / calendar.json / approvals.json / attendance.json / sns.json / corp.json / employees.json
// 파일들을 두고, 매 CRUD 때마다 그 파일 전체를 읽고 다시 씁니다. (소규모 사내용으로 충분한 방식)

const Drive = (() => {
  let tokenClient = null;
  let accessToken = null;
  let gapiReady = false;
  let pickerReady = false;
  let currentUser = null; // {name, email, picture}
  const fileIdCache = {}; // { "notices.json": "driveFileId" }

  function loadGapiClient() {
    return new Promise((resolve) => {
      gapi.load("client:picker", async () => {
        await gapi.client.init({
          apiKey: CONFIG.API_KEY,
          discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
        });
        gapiReady = true;
        pickerReady = true;
        resolve();
      });
    });
  }

  // ---- 로그인 유지 ----
  // 구글 액세스 토큰은 보통 1시간 동안 유효해요. 새로고침할 때마다 팝업으로 다시
  // 로그인시키는 대신, 토큰과 만료 시각을 localStorage에 저장해두고 아직 유효하면
  // 그대로 재사용합니다. (팝업 기반 재로그인은 브라우저의 팝업 차단 때문에
  // 페이지 로드 시 자동으로 실행할 수 없어서, 캐시된 토큰 재사용이 훨씬 안정적이에요.)
  const TOKEN_KEY = "gw_accessToken";
  const TOKEN_EXPIRY_KEY = "gw_tokenExpiry";
  const TOKEN_SAFETY_MARGIN_MS = 2 * 60 * 1000; // 만료 2분 전에는 새 토큰으로 취급하지 않음

  function storeToken(token, expiresInSec) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_EXPIRY_KEY, String(Date.now() + expiresInSec * 1000));
  }

  function clearStoredToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  }

  function getValidStoredToken() {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiry = Number(localStorage.getItem(TOKEN_EXPIRY_KEY) || 0);
    if (token && expiry - TOKEN_SAFETY_MARGIN_MS > Date.now()) return token;
    return null;
  }

  // 캐시된 토큰이 아직 살아있으면 팝업 없이 바로 로그인 상태로 복원합니다.
  async function restoreSession() {
    const token = getValidStoredToken();
    if (!token) return null;
    accessToken = token;
    gapi.client.setToken({ access_token: accessToken });
    try {
      await fetchUserInfo();
      return currentUser;
    } catch (e) {
      // 토큰이 이미 구글 쪽에서 무효화된 경우 등
      clearStoredToken();
      accessToken = null;
      return null;
    }
  }

  function initTokenClient(onToken) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: async (resp) => {
        if (resp.error) {
          onToken(null, resp);
          return;
        }
        accessToken = resp.access_token;
        gapi.client.setToken({ access_token: accessToken });
        storeToken(accessToken, Number(resp.expires_in) || 3600);
        await fetchUserInfo();
        onToken(currentUser, null);
      },
    });
  }

  async function fetchUserInfo() {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!res.ok) throw new Error("사용자 정보를 불러오지 못했어요 (" + res.status + ")");
    const data = await res.json();
    currentUser = { name: data.name, email: data.email, picture: data.picture };
  }

  function requestSignIn() {
    tokenClient.requestAccessToken({ prompt: "" });
  }

  function requestSignInConsent() {
    tokenClient.requestAccessToken({ prompt: "consent" });
  }

  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    currentUser = null;
    clearStoredToken();
    Object.keys(fileIdCache).forEach((k) => delete fileIdCache[k]);
  }

  // ---- 폴더 관련 ----
  // 구글 드라이브 자체를 "서버"로 쓰는 구조라, 같은 계정에 데이터 폴더가 여러 개
  // 생기면 안 돼요 (탭마다/기기마다 새로 로그인할 때 로컬에 저장된 폴더 ID가 없으면
  // 예전엔 매번 새 폴더를 만들어버렸어요). 그래서 폴더를 만들기 전에 항상 먼저
  // 내 드라이브에 이미 같은 이름의 폴더(휴지통 제외)가 있는지부터 찾아보고, 있으면
  // 그 폴더를 그대로 재사용합니다. 정말 하나도 없을 때만 새로 만들어요.
  async function findDataFolder() {
    const res = await gapi.client.drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${CONFIG.DATA_FOLDER_NAME}' and trashed=false and 'me' in owners`,
      fields: "files(id, name, createdTime)",
      spaces: "drive",
      orderBy: "createdTime",
    });
    const files = (res.result.files || []).sort((a, b) => (a.createdTime || "").localeCompare(b.createdTime || ""));
    return files[0] || null;
  }

  async function createDataFolder() {
    const existing = await findDataFolder();
    if (existing) return existing;
    const res = await gapi.client.drive.files.create({
      resource: {
        name: CONFIG.DATA_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id, name",
    });
    return res.result;
  }

  function openFolderPicker() {
    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(CONFIG.API_KEY)
        .addView(view)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const folder = data.docs[0];
            resolve({ id: folder.id, name: folder.name });
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  // ---- JSON "컬렉션 파일" 읽기/쓰기 ----
  // 같은 폴더 안에 같은 이름의 파일이 실수로 여러 개 생겼더라도(예: 여러 기기에서
  // 거의 동시에 처음 접속) 항상 "가장 먼저 만들어진 파일"을 일관되게 골라서 써요.
  // 그래야 매번 다른 파일이 선택되어 데이터가 왔다갔다 하는 일이 없어요.
  async function findFileInFolder(folderId, filename) {
    const res = await gapi.client.drive.files.list({
      q: `'${folderId}' in parents and name='${filename}' and trashed=false`,
      fields: "files(id, name, createdTime)",
      spaces: "drive",
      orderBy: "createdTime",
    });
    const files = (res.result.files || []).sort((a, b) => (a.createdTime || "").localeCompare(b.createdTime || ""));
    return files[0];
  }

  async function ensureFile(folderId, filename, initialData) {
    if (fileIdCache[filename]) return fileIdCache[filename];
    let file = await findFileInFolder(folderId, filename);
    if (!file) {
      const boundary = "-------314159265358979323846";
      const metadata = { name: filename, parents: [folderId], mimeType: "application/json" };
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
        JSON.stringify(initialData) +
        `\r\n--${boundary}--`;
      const createRes = await gapi.client.request({
        path: "/upload/drive/v3/files",
        method: "POST",
        params: { uploadType: "multipart", fields: "id" },
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      file = { id: createRes.result.id };
    }
    fileIdCache[filename] = file.id;
    return file.id;
  }

  async function readCollection(folderId, filename, initialData) {
    const fileId = await ensureFile(folderId, filename, initialData);
    const res = await gapi.client.drive.files.get({ fileId, alt: "media" });
    try {
      return typeof res.body === "string" ? JSON.parse(res.body) : res.result;
    } catch (e) {
      return initialData;
    }
  }

  async function writeCollection(folderId, filename, dataObj) {
    const fileId = await ensureFile(folderId, filename, dataObj);
    await gapi.client.request({
      path: `/upload/drive/v3/files/${fileId}`,
      method: "PATCH",
      params: { uploadType: "media" },
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dataObj),
    });
  }

  // ---- 일반 서류 파일 업로드 (등기부등본, 정관, 사업자등록증 등) ----
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // existingFileId가 있으면 그 파일의 내용을 갱신(같은 링크 유지), 없으면 새로 만듭니다.
  async function uploadDocument(folderId, file, existingFileId) {
    const base64Data = await fileToBase64(file);
    const mimeType = file.type || "application/octet-stream";
    const metadata = existingFileId
      ? { name: file.name }
      : { name: file.name, parents: [folderId] };
    const boundary = "-------314159265358979323846";
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      base64Data +
      `\r\n--${boundary}--`;
    const path = existingFileId ? `/upload/drive/v3/files/${existingFileId}` : "/upload/drive/v3/files";
    const method = existingFileId ? "PATCH" : "POST";
    const res = await gapi.client.request({
      path,
      method,
      params: { uploadType: "multipart", fields: "id, name, webViewLink, modifiedTime" },
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.result;
  }

  // 이미 드라이브에 올라간 서류 파일을 base64로 내려받기 (AI 분석에 보내기 위함)
  async function downloadFileAsBase64(fileId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!res.ok) throw new Error("파일을 불러오지 못했어요 (" + res.status + ")");
    const blob = await res.blob();
    const mimeType = blob.type || "application/octet-stream";
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { base64, mimeType };
  }

  // ---- 구글 캘린더 연동 (아이폰 캘린더에서 보이게 하기) ----
  // calendar.app.created 스코프는 "이 앱이 직접 만든 캘린더"에만 접근할 수 있어요.
  // 그래서 사용자의 기존 캘린더 목록을 검색하는 게 아니라, 한 번 만든 캘린더의 ID를
  // localStorage에 저장해두고 계속 재사용해요. 아이폰에서는 Settings > 캘린더 > 계정 >
  // (이 그룹웨어에 로그인한 구글 계정) 을 추가/동기화 켜두면 이 캘린더가 자동으로 보여요.
  const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
  const GOOGLE_CALENDAR_ID_KEY = "gw_googleCalendarId";
  const GOOGLE_CALENDAR_NAME = "그룹웨어 일정";

  async function calFetch(path, options) {
    const res = await fetch(CALENDAR_API + path, {
      ...(options || {}),
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json", ...((options && options.headers) || {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`캘린더 API 오류 (${res.status}): ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function isCalendarLinked() {
    return !!localStorage.getItem(GOOGLE_CALENDAR_ID_KEY);
  }

  // 처음 연동할 때 한 번 호출: 아직 스코프 동의를 안 받았으면 동의창을 띄우고,
  // "그룹웨어 일정" 캘린더를 (없으면) 새로 만들어서 ID를 저장해요.
  async function linkGoogleCalendar() {
    const originalCallback = tokenClient.callback;
    try {
      await new Promise((resolve, reject) => {
        tokenClient.callback = async (resp) => {
          if (resp.error) {
            reject(new Error("구글 캘린더 접근 권한 동의가 필요해요."));
            return;
          }
          accessToken = resp.access_token;
          gapi.client.setToken({ access_token: accessToken });
          storeToken(accessToken, Number(resp.expires_in) || 3600);
          resolve();
        };
        tokenClient.requestAccessToken({ prompt: "consent" });
      });
    } finally {
      // 로그인 유지용으로 앱이 처음에 등록해둔 콜백으로 되돌려놔요.
      tokenClient.callback = originalCallback;
    }
    return ensureGroupwareCalendar();
  }

  async function ensureGroupwareCalendar() {
    const cached = localStorage.getItem(GOOGLE_CALENDAR_ID_KEY);
    if (cached) return cached;
    const created = await calFetch("/calendars", {
      method: "POST",
      body: JSON.stringify({ summary: GOOGLE_CALENDAR_NAME, description: "그룹웨어 앱의 일정/캘린더 탭과 자동으로 동기화돼요." }),
    });
    localStorage.setItem(GOOGLE_CALENDAR_ID_KEY, created.id);
    return created.id;
  }

  function addOneDay(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  // 내부 일정(evt: {title, date, endDate, memo, googleEventId})을 구글 캘린더에 새로 만들거나
  // 갱신해요. 구글 종일 일정은 end.date가 "시작일 다음날"이어야 하루짜리로 표시돼요.
  async function upsertCalendarEvent(evt) {
    const calId = await ensureGroupwareCalendar();
    const body = {
      summary: evt.title || "(제목없음)",
      description: evt.memo || "",
      start: { date: evt.date },
      end: { date: addOneDay(evt.endDate || evt.date) },
    };
    if (evt.googleEventId) {
      try {
        const updated = await calFetch(`/calendars/${encodeURIComponent(calId)}/events/${evt.googleEventId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        return updated.id;
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e; // 구글쪽에서 이미 지워졌으면 새로 만들어요
      }
    }
    const created = await calFetch(`/calendars/${encodeURIComponent(calId)}/events`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return created.id;
  }

  async function deleteCalendarEvent(googleEventId) {
    if (!googleEventId) return;
    const calId = await ensureGroupwareCalendar();
    try {
      await calFetch(`/calendars/${encodeURIComponent(calId)}/events/${googleEventId}`, { method: "DELETE" });
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }

  return {
    loadGapiClient,
    initTokenClient,
    restoreSession,
    requestSignIn,
    requestSignInConsent,
    signOut,
    findDataFolder,
    createDataFolder,
    openFolderPicker,
    readCollection,
    writeCollection,
    uploadDocument,
    downloadFileAsBase64,
    isCalendarLinked,
    linkGoogleCalendar,
    upsertCalendarEvent,
    deleteCalendarEvent,
    get user() {
      return currentUser;
    },
    get isPickerReady() {
      return pickerReady;
    },
  };
})();
