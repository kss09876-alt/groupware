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
  async function createDataFolder() {
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
  async function findFileInFolder(folderId, filename) {
    const res = await gapi.client.drive.files.list({
      q: `'${folderId}' in parents and name='${filename}' and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
    });
    return res.result.files && res.result.files[0];
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

  return {
    loadGapiClient,
    initTokenClient,
    restoreSession,
    requestSignIn,
    requestSignInConsent,
    signOut,
    createDataFolder,
    openFolderPicker,
    readCollection,
    writeCollection,
    uploadDocument,
    downloadFileAsBase64,
    get user() {
      return currentUser;
    },
    get isPickerReady() {
      return pickerReady;
    },
  };
})();
