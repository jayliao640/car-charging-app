汽車充電紀錄 v1.0 正式版

核心功能
- 預設車輛：BQH-8307，電池容量 22 kWh。
- 可新增、編輯、刪除其他車號及設定不同電池容量。
- 可設定預設車輛。
- 每筆紀錄包含車輛、日期、SOC%、kWh、備註、建立時間、修改時間。
- Firestore 同步文字紀錄，iPhone、Android、電腦可共用。
- 照片壓縮至 1MB 以下，僅存在拍照或選取照片的原始裝置 IndexedDB，不上傳 Firebase Storage。
- 可依日期及車輛統計充電次數、區間總用電度數、平均用電。
- 可編輯、刪除及匯出 CSV。
- 可安裝為 iPhone／Android PWA。

GitHub 上傳檔案
index.html
app.js
config.js
manifest.json
service-worker.js
icon-192.png
icon-512.png

Firebase 必要設定
1. Authentication 啟用 Anonymous（匿名）。
2. Firestore 已建立。
3. 不需要啟用 Storage。

Firestore Rules
請到 Firestore → 規則，貼入並發布：

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sharedRecords/{recordId} {
      allow read, write: if request.auth != null;
    }
    match /sharedVehicles/{vehicleId} {
      allow read, write: if request.auth != null;
    }
  }
}

重要說明
- 照片只存在原始 iPhone／Android／瀏覽器本機。
- 清除 Safari／Chrome 網站資料、刪除 App 或換手機，照片可能消失，但文字紀錄仍在 Firestore。
- 其他裝置若發現該筆紀錄原始裝置曾附照片，會顯示「照片僅保存在原始裝置」。
