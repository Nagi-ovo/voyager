# 隱私政策

最後更新：2026年9月7日

## 簡介

Voyager（以下簡稱「我們」）致力於保護您的隱私。本隱私政策說明了我們的瀏覽器擴充功能如何收集、使用和保護您的資訊。

## 資料收集與使用

**我們不收集任何個人資訊。**

Voyager 完全在您的瀏覽器本地運作。擴充功能產生或管理的所有資料（如資料夾、提示詞範本、星標訊息和設定）均儲存在：

1. 您的本地裝置上（`chrome.storage.local`）
2. 您的瀏覽器同步儲存空間中（`chrome.storage.sync`，如可用），以便在您的裝置間同步設定。

我們無法存取您的個人資料、聊天記錄或其他任何隱私資訊。我們也不會追蹤您的瀏覽歷史。

## Google Drive 同步（選用）

如果您主動啟用 Google Drive 同步功能，Chrome、Edge 與 Firefox 會使用瀏覽器身分 API；Safari 直裝版則使用原生 Google Sign-In，並將憑證保存在 macOS 鑰匙圈中。兩種方式都只申請 `drive.file` 範圍，直接在您的裝置與**您自己的 Google Drive**之間傳輸資料；OAuth 權杖不會傳送到 Voyager 伺服器。

## Safari iCloud 同步（選用）

Safari 直裝版可將選定的備份資料直接寫入您 iCloud 帳戶的私有 CloudKit 資料庫。Voyager 不會取得您的 Apple ID 或 iCloud 驗證權杖，開發者也無法存取該私有資料庫中的記錄。

## 外掛目錄線上更新（選用）

在您已啟用至少一個外掛的網站上，Voyager 可能會透過 HTTPS 取得該網站的外掛目錄檔案 `https://voyager.nagi.fun/catalog/hosts/<網站主機名稱>.json`，例如 `https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json`。檢查只會在開啟這類頁面、或在這類頁面上開啟擴充功能視窗時進行，而且距離上次檢查必須超過您選擇的間隔（預設 6 小時，可選 1 小時、6 小時、24 小時或僅手動）。Gemini 與 AI Studio 頁面沒有外掛，因此不會產生任何請求。該請求是一般的 GET：不會帶上 Cookie，不會帶上帳戶或擴充功能識別碼，也不會帶上頁面或對話內容；與任何網路請求一樣，伺服器可以看到發出請求的 IP 位址、瀏覽器 User-Agent，以及網址路徑中的網站主機名稱。在有外掛的網站上，擴充功能視窗提供「外掛線上更新」開關與檢查間隔選項，兩項設定都保存在瀏覽器同步儲存空間中，並包含在設定備份內。關閉該開關後，除非您按下「立即檢查外掛更新」，Voyager 不會連線到 voyager.nagi.fun。若請求失敗或該網站沒有目錄檔案，擴充功能會繼續使用隨附的外掛快照。取得的目錄只包含 CSS 與 JSON，使用前會經過驗證與淨化；不會下載或執行任何 JavaScript。voyager.nagi.fun 是由 Cloudflare 代理的靜態託管網站，Voyager 專案不記錄、不保存這些請求；連線中繼資料（IP 位址、User-Agent）由託管方依其自身隱私政策處理。

## 權限說明

本擴充功能僅申請維持功能所需的最小權限：

- **Storage（儲存）**：用於在本地和跨裝置儲存您的偏好設定、資料夾、提示詞、星標訊息和介面自訂選項。
- **Identity（身分驗證）**：用於 Google Drive 同步功能的 Google 驗證。僅在您主動啟用雲端同步時使用。
- **Scripting（腳本注入）**：用於在 Gemini 頁面及使用者指定的自訂網站上動態注入內容腳本（提示詞管理器功能）。僅注入擴充功能自身打包的腳本，不會載入或執行任何遠端程式碼。
- **Host Permissions（主機權限）**（gemini.google.com、aistudio.google.com 等）：用於注入增強 Gemini 介面的內容腳本，提供資料夾、匯出、時間線、引用回覆等功能。Google 相關網域（googleapis.com、accounts.google.com）用於 Google Drive 同步驗證。
- **Optional Host Permissions（選用主機權限）**（所有 URL）：僅在您主動新增提示詞管理器的自訂網站時按需請求，不會在未經您操作的情況下啟用。

## 第三方服務

Voyager 不會與任何第三方服務、廣告商或分析提供商共享資料。

## 政策變更

我們可能會不時更新隱私政策。我們將透過在此頁面發佈新的隱私政策來通知您任何變更。

## 聯絡我們

如果您對本隱私政策有任何疑問，請透過我們的 [GitHub 儲存庫](https://github.com/Nagi-ovo/voyager) 聯絡我們。
