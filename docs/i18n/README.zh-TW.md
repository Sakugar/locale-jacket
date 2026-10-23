# Locale Jacket

[English](../../README.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [Português (Brasil)](README.pt-BR.md)

> 本文為英文 README 的翻譯。如有出入，以[英文版](../../README.md)為準；開發與技術細節也請參閱英文版。

Locale Jacket 是一個 Chrome / Edge（Manifest V3）擴充功能：**依網站**讓網頁看到不同的瀏覽器語言（例如 google.com 看到 `en-US`，apple.com 看到 `ja-JP`），而瀏覽器本身的介面語言（例如繁體中文）保持不變。

它把 **開發人員工具 ▸ 感應器 ▸ 地區設定（Locale）** 的效果自動套用到所有符合的分頁，不必開啟開發人員工具。規則寫法與 Clash、sing-box、Shadowrocket 相同：`DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`DOMAIN-REGEX`、`GEOSITE`、`IP-CIDR`、`IP-CIDR6`、`IP-ASN`、`GEOIP`，並支援 `SYSTEM`/`DIRECT` 例外與預設動作。

## 功能

| 網站讀到的內容 | 偽裝方式 | 涵蓋範圍 |
|---|---|---|
| `Intl.*`（DateTimeFormat、NumberFormat、Collator、`toLocaleString` 等） | `Emulation.setLocaleOverride` | 頁面、同站與跨站框架、專用 Worker |
| `navigator.language`、`navigator.languages` | 僅設定 `acceptLanguage` 的 `Emulation.setUserAgentOverride`（User-Agent 與用戶端提示不變） | 頁面、框架、專用 Worker |
| HTTP `Accept-Language` | 同上，並對第一個文件請求使用 `declarativeNetRequest` | 文件、子資源、`fetch()`、Worker 請求 |
| 時區、地理位置 | **預設關閉**，可依規則開啟 | 頁面與框架 |

- 不竄改任何網頁 JavaScript API，完全使用 Chrome 內建的模擬功能。
- 一切都在本機執行：沒有伺服器、帳戶或遙測。
- 介面支援 10 種語言（見下文）。

## 安裝

**從 Release 安裝（建議）**
1. 在 GitHub 的 Releases 頁面下載 `locale-jacket-<版本>.zip` 並解壓縮。
2. 開啟 `chrome://extensions`（Edge：`edge://extensions`），開啟「開發人員模式」，按「載入未封裝項目」，選擇解壓縮後的資料夾。
3. 將擴充功能圖示釘選到工具列，徽章（如 `EN`、`JA`）會顯示目前分頁使用的語言設定檔。若要在無痕視窗中使用，請在擴充功能詳細資料頁開啟「在無痕模式下啟用」。

**升級**：從上一版的未封裝資料夾升級時，可使用 `locale-jacket-<舊版>-to-<新版>.diff.zip`。它只包含新增或修改過的檔案：複製覆蓋到舊資料夾，刪除 `DELETED.txt` 列出的檔案（如有），再重新載入擴充功能即可。擴充功能 ID 與設定都會保留。

**`.crx` 檔案**：以同一金鑰簽署（ID `jenefdmhnbfepiohiplfobageceacokb`），但 Chrome / Edge 只有在企業政策允許時才會安裝商店以外的 `.crx`。個人使用請選擇「載入未封裝項目」。

**從原始碼建置**：需要 Node.js 20+，執行 `npm install` 與 `npm run build`，再載入產生的 `dist/` 資料夾。支援 Chrome / Edge 125 以上版本（在 155 上開發與測試）。

**首次執行的規則**：首次安裝時，擴充功能會讀取資料夾中的 `presets/default-rules.yaml`（與「匯入 / 匯出」格式相同）。在載入資料夾前編輯它，即可從自己的規則開始。`.crx` 不包含此檔案，會自動產生相同的範例預設。

## 預設規則

| 規則 | 結果 |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM`（保留真實語言） |
| 預設 | `SYSTEM` |

可在彈出視窗或「選項」頁面中自由修改或刪除。

## 偵錯提示列

只要有分頁處於偽裝狀態，Chrome 就會顯示 **「Locale Jacket 已開始對這個瀏覽器進行偵錯」**。這是 Chrome 針對 `chrome.debugger` API 的安全提示，擴充功能不會隱藏它。按「取消」會暫停 Locale Jacket，之後可在彈出視窗中按「繼續」。

如果你接受其中的安全取捨，可使用 [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1)（Windows）為 Chrome 加上 `--silent-debugger-extension-api` 啟動參數。注意：這會對**所有**使用偵錯權限的擴充功能隱藏此提示。詳細說明請見[英文 README](../../README.md#hiding-the-debugging-banner-optional)。

## 使用方式

**彈出視窗**（工具列圖示）：全域開關；目前分頁符合的規則、語言設定檔與狀態；「檢查網頁實際讀到的值」；為目前網站新增或修改規則；設定其他所有網站的預設動作。

**選項頁面**：
- **規則**：啟用 / 停用、排序、編輯、刪除，並標示重複、衝突與多餘的規則。
- **測試與驗證**：輸入主機名稱查看符合的規則與原因，或檢查已開啟分頁實際回報的值。
- **匯入 / 匯出**：JSON 或 YAML，可取代或合併。
- **資料集**：GeoSite / GeoIP / ASN 資料的下載、匯入與自動更新。
- **設定**：介面語言、框架模式等。
- **工作階段與記錄**：正在偵錯的分頁與記憶體中的活動記錄。

## 規則

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com 及其所有子網域（依標籤邊界）
    domain: google.com
    locale: en-US
  - type: DOMAIN               # 僅完全符合此主機名稱
    domain: accounts.google.com
    action: SYSTEM             # 保留瀏覽器真實語言（DIRECT 為別名）
  - type: DOMAIN-KEYWORD       # 主機名稱包含此文字
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # 也支援 Clash 風格的簡寫
  - GEOSITE,google,en-US              # 需要 GeoSite 資料集
  - IP-CIDR,17.0.0.0/8,en-US          # 伺服器位址位於此範圍
  - GEOIP,LAN,SYSTEM                  # 私人位址，不需資料
default:
  mode: SYSTEM                 # 或 mode: PROFILE + locale/languages/…
```

**優先順序**（結果固定，第一個差異決定勝負）：
1. 規則類型：`DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`。主機名稱規則永遠優先於 IP 規則。
2. 同類規則中越具體越優先（標籤較多的後綴、前綴較長的範圍）。
3. `priority` 數值較大者優先。
4. 清單中位置較前者優先。
5. 沒有規則符合時才使用預設動作。

因此不論順序，`DOMAIN,accounts.google.com → SYSTEM` 都會覆蓋 `DOMAIN-SUFFIX,google.com → en-US`。

## 規則訂閱

*選項 ▸ 訂閱* 會從網路上的 JSON 或 YAML 檔案（與*匯入 / 匯出*格式相同）取得規則並保持最新：新增後立即取得，之後每天（或每週、每月、永不）以條件請求更新。GitHub 檔案頁面（`github.com/…/blob/…`）或 gist 的連結會轉換為原始檔案；回傳網頁的位址會被拒絕並附上說明。訂閱規則與你自己的規則分開儲存，只能檢視：順序為：你的規則、訂閱規則、你的特殊規則（GEOSITE 與 IP 規則）、訂閱的特殊規則；訂閱之間排在上面的優先。檔案中只讀取 `rules`，無效項目會被略過。如果訂閱規則需要 GeoSite、GeoIP 或 ASN 而該資料集未安裝，會自動下載——優先使用檔案中 `datasets:` 指定的位址，否則使用預設位址。

## 資料集與自動更新

`GEOSITE`、`GEOIP` 國家/地區與 `IP-ASN` 規則需要資料檔。除非你主動要求，否則不會下載任何內容：在「選項 ▸ 資料集」中從可編輯的網址下載，或匯入本機檔案。

**自動更新**（選用，預設關閉）：可在瀏覽器啟動時和/或每天、每週、每月檢查已下載的資料集。「最短間隔」（預設 24 小時，可設 1–720 小時）限制每個資料集的自動嘗試次數，失敗的嘗試也計算在內，因此反覆重新啟動瀏覽器也不會重複下載。請求為條件式請求，檔案未變更時不會重新下載。從檔案匯入的資料集不會自動更新。

IP 規則使用 Chrome 實際連線的伺服器位址，擴充功能不會進行 DNS 查詢。

## 介面語言

彈出視窗與選項頁面支援 English、简体中文、繁體中文、日本語、한국어、Deutsch、Français、Español、Русский、Português (Brasil)。預設跟隨瀏覽器介面語言，可在「選項 ▸ 設定 ▸ 介面語言」中變更。此設定不會影響網站看到的語言。

## 更新

已安裝的版本會顯示在彈出視窗標題旁與選項頁側邊欄底部。*選項 ▸ 更新* 會檢查新版本：只有在你按下 **立即檢查** 或開啟自動檢查（預設關閉，最多每 12 小時一次）時才會檢查，而且只連線到頁面上顯示的發布位址。發現新版本時只會提示：彈出視窗顯示提示，「更新」連結旁顯示版本號，頁面提供發布頁面的連結。擴充功能不會自行下載或安裝任何內容；更新方法請見「安裝」。在 GitHub 存放庫維持私人期間，GitHub 會回應 404，頁面會說明這一點。

## 隱私與權限

一切都在本機執行。除了你在「資料集」中發起的下載與你開啟的自動更新（皆從所示網址取得）、你在「更新」中發起或開啟的更新檢查（只連線到所示的發布位址），以及你在「訂閱」中新增的訂閱（連線到其位址，以及其規則所需的資料集）外，擴充功能不會發出任何網路請求。規則儲存在 `chrome.storage.local`；活動記錄只保存在記憶體中，且只包含主機名稱。

權限：`debugger`（模擬功能本身）、`webNavigation` 與網站存取權、`declarativeNetRequestWithHostAccess`（第一個請求的 Accept-Language）、`webRequest`（IP 規則所需的伺服器位址，以及判斷頁面載入能否安全重新開始，僅觀察）、`alarms`（定期檢查資料集與擴充功能更新，僅在開啟時）、`scripting`（僅在你檢查時，讀取沒有偵錯工作階段的分頁回報的值）、`storage`。

## 限制

- 偵錯提示列無法由擴充功能隱藏（見上文）。
- `chrome://`、`edge://` 頁面、新分頁、線上應用程式商店及遭政策封鎖的網站無法偵錯。
- 從新分頁直接輸入網址時，頁面最早的指令碼可能看到真實語言；HTTP 標頭仍然正確，頁面可自動重新載入一次。
- 每個轉譯器程序只能有一種 Intl 語言；共用程序的不同設定檔會顯示為「部分生效」。
- Service Worker 與共用 Worker 不會被覆寫。

完整說明見 [docs/LIMITATIONS.md](../LIMITATIONS.md)，常見問題見 [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md)（英文）。

## 授權

GPL-3.0，見 [LICENSE](../../LICENSE)。
