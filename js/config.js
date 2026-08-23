// ⚙️ 여기에 본인의 Google Cloud 값을 채워주세요. (README.md 참고)
// 1) Google Cloud Console > API 및 서비스 > 사용자 인증 정보 에서 만든
//    "OAuth 2.0 클라이언트 ID"의 클라이언트 ID를 CLIENT_ID 에 넣으세요.
// 2) 같은 화면에서 만든 "API 키"를 API_KEY 에 넣으세요.
const CONFIG = {
  CLIENT_ID: "957720183451-pa3snmiqbq0ke36aaj7saubc6arovion.apps.googleusercontent.com",
  API_KEY: "AIzaSyBXYZF1azXr0CKon5CQ24YYDrknKUzEd44",
  // drive.file 스코프: 이 앱이 만들거나, 사용자가 Picker로 명시적으로 연 파일/폴더에만 접근합니다.
  SCOPES: "https://www.googleapis.com/auth/drive.file profile email",
  DATA_FOLDER_NAME: "groupware_data",
  // 3) 법인정보 서류를 AI로 자동 분석하는 기능을 쓰려면, Cloudflare Worker를 배포한 뒤
  //    그 주소(https://xxxx.workers.dev 형태)를 아래에 넣으세요. (README.md의 "AI 자동 채우기 설정" 참고)
  //    비워두면 "AI로 채우기" 버튼을 눌렀을 때 안내 메시지만 뜨고 동작하지 않아요.
  AI_WORKER_URL: "https://groupware-ai.mute-grass-c2d7.workers.dev",
};
