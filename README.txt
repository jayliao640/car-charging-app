汽車充電紀錄 PWA v8（儲存按鈕修正版）

修正內容：
- 修正 index.html 與 app.js 版本不同步時，程式在開啟畫面就停止，導致：
  1. 輸入 78% 仍顯示 0.00 kWh。
  2. 按「儲存紀錄」沒有反應。
- 提升 iPhone Safari 相容性。
- 保留日期區間總用電度數。
- 增加程式錯誤提示。
- Service Worker 快取版本更新為 v8。

更新 GitHub 時，請務必同時覆蓋：
index.html
app.js
service-worker.js

建議也一起覆蓋全部七個檔案：
index.html
app.js
config.js
manifest.json
service-worker.js
icon-192.png
icon-512.png

上傳完成後：
1. 等 GitHub Pages 部署完成。
2. iPhone Safari 開啟網站並重新整理。
3. 若主畫面 App 還是舊版，刪除主畫面捷徑後重新加入。
