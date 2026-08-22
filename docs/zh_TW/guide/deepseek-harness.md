# DeepSeek Harness

DeepSeek 官方的開源編碼 agent，跑在你自己的機器上。

它有個網頁介面，位址是 `localhost:3080`。

網頁介面，就意味著 Voyager 能進去。

## 為什麼能進去

Voyager 的提示詞庫不認網域，只認「你加過的站點」。

本機位址也是站點。

所以 DeepSeek Harness 和 Gemini、Claude、ChatGPT 一樣，都是它能落腳的地方。

## 三步接上

### 1. 把 DSH 跑起來

```bash
npm i -g @deepseek-ai/dsh
dsh web
```

瀏覽器打開 `http://localhost:3080`。

### 2. 在彈窗裡打開開關

![點工具列的拼圖圖標，點 Voyager，打開「在 localhost:3080 上開啟提示詞管理器」](/assets/dsh-enable-steps-zh.png)

因為你人就在 `localhost:3080` 這個頁面上，彈窗頂上會直接出現這一條。打開它，授權存取。

不用手打位址。

### 3. 重新整理頁面

浮窗按鈕就出現在右下角了。

![在 DeepSeek Harness 中執行的提示詞管理器](/assets/prompt-manager-deepseek-harness.png)

## 同一份提示詞庫

不是每個站點一個庫，是一個庫跟著你走。

你在 Gemini、Claude、ChatGPT 上存過的提示詞，打開 DSH 就在那兒，一條不少。反過來也一樣：在 DSH 裡新寫的提示詞，回到 Gemini 照樣叫得出來。

標籤、收藏、搜尋，全都是同一套。

![同一份提示詞庫，落到每一個介面上](/assets/one-prompt-library.png)

## 幾件小事

**連接埠不是固定的。** DSH 還在開發者預覽版，預設連接埠以後可能變。真變了，按新的再加一次就行。

**只有提示詞庫會載入。** 時間軸、資料夾這些是為 Gemini 寫的，在自定義網站上不會啟動。

**你的提示詞沒有離開這台機器。** DSH 在本機，Voyager 的庫也在本機。整條鏈路不出門。

::: tip
同樣的辦法適用於任何本機 Web UI——Open WebUI、LibreChat、你自己寫的那個。填位址，重新整理，就有了。
:::
