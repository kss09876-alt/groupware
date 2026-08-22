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
        await fetchUserInfo();
        onToken(currentUser, null);
      },
    });
  }

  async function fetchUserInfo() {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken },
    });
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

  return {
    loadGapiClient,
    initTokenClient,
    requestSignIn,
    requestSignInConsent,
    signOut,
    createDataFolder,
    openFolderPicker,
    readCollection,
    writeCollection,
    get user() {
      return currentUser;
    },
    get isPickerReady() {
      return pickerReady;
    },
  };
})();
