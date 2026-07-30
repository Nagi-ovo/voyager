# 貢献ガイド

> [!CAUTION]
> **本プロジェクトは現在、新機能の PR を受け付けていません。** どうしても実装したい機能がある場合は、以下のプロセスに従ってください：
>
> 1. **まず Issue を作成して**、メンテナーとアイデアやアプローチについて議論してください
> 2. **承認と確実な実装計画が決まってから**、コードを書いて PR を提出してください
>
> 事前の議論なしに提出された新機能の PR は、レビューなしにクローズされます。ご理解のほどよろしくお願いいたします。

> [!IMPORTANT]
> **プロジェクトの状態: 低頻度メンテナンス。** 返信が遅れる可能性があります。テスト付きのPRが優先されます。

Voyager への貢献をご検討いただきありがとうございます！🚀

このドキュメントでは、貢献のためのガイドラインと手順を説明します。バグ修正、ドキュメントの改善、翻訳などの貢献を歓迎します。新機能については、まず Issue で議論してください。

## 🚫 AI ポリシー

**手動で検証されていない AI 生成の PR は明示的に拒否します。**

AI ツールは優れたアシスタントですが、「怠惰な」コピー＆ペーストの貢献はメンテナの時間を浪費します。

- **低品質な AI PR** は、議論なしに即座にクローズされます。
- ロジックの**説明がない PR** や、必要なテストが不足している PR は拒否されます。
- あなたは提出するすべてのコード行を理解し、責任を負う必要があります。

## 必須フロー

1. 新機能は Issue を作成し、方針に対する明示的な承認を待ってください。`/claim` や割り当ては担当者を示すだけです。
2. 各変更はトピックブランチから焦点を絞った PR として提出し、`main` へ直接プッシュしないでください。
3. `bun run format`、`bun run lint`、`bun run verify:pr` の順に実行し、未実行項目を記載してください。ドキュメントのみの変更（docs/README）の場合は、`bun run format:check` と `bun run docs:build` で完全な `verify:pr` を代替できます。
4. 動作変更には回帰テストを追加するか、自動化が有用でない理由を説明してください。
5. 影響するブラウザで実際の成果物を読み込み、変更したフローを確認してください。未確認項目と担当者は PR に記載します。

> 💡 AI エージェント（Claude Code、Codex など）で貢献する場合は、リポジトリに同梱の `voyager-contribute` skill（`.claude/skills/` と `.agents/skills/`）を使うよう指示してください。本ワークフローに加え、過去の PR で最もレビュー往復を要したリポジトリ固有の落とし穴を網羅しています。リポジトリ外のエージェント（Cursor など）では `npx skills add Nagi-ovo/voyager -s voyager-contribute` でインストールできます。

## 目次

- [はじめに](#はじめに)
- [Issue の担当](#issue-の担当)
- [開発環境のセットアップ](#開発環境のセットアップ)
- [変更の実施](#変更の実施)
- [Pull Request の送信](#pull-request-の送信)
- [コードスタイル](#コードスタイル)
- [Gem サポートの追加](#gem-サポートの追加)
- [ライセンス](#ライセンス)

---

## はじめに

### 前提条件

- **Bun 1.3.12**（`packageManager` および CI と統一）
- **GitHub CLI（`gh`）**（[インストール](https://cli.github.com/)）：インストール後 `gh auth login` で認証してください。その後、`gh auth status` で有効なアカウントが貢献に使うアカウントであることを確認してください。`voyager-contribute` skill は Issue/PR の照会・公開に `gh` を利用します。`gh` がない場合は GitHub の Web UI を使い、その旨を PR に記載してください。
- 拡張機能を読み込み、実際のフローを確認する対象ブラウザ

### クイックスタート

```bash
# リポジトリをクローン
git clone https://github.com/Nagi-ovo/voyager.git
cd voyager

# 依存関係をインストール
bun install

# 開発モードを開始
bun run dev
```

---

## Issue の担当

重複作業を避け、貢献を調整するために：

### 1. 既存の作業を確認

開始する前に、Issue の **Assignees** セクションを見て、すでに誰かが担当していないか確認してください。

### 2. Issue を担当する

`community-only` ラベルが付いていない未割り当ての Issue では、`/claim` とコメントすると自動的に担当者へ割り当てられます。ボットが割り当てを確認します。

### 3. コミュニティ限定 Issue

`community-only` ラベルの Issue は、確認済みの Voyager コミュニティメンバー専用です：

1. コミュニティメンバーが `/claim` とコメントします。
2. メンテナーがメンバー資格を確認し、`/approve @username` とコメントします。
3. ボットによる割り当て後に実装や PR の作成を開始してください。

このラベルを付けると、`help wanted` と `good first issue` は自動的に削除されます。その他のコントリビューターは [Voyager Discord](https://discord.gg/TEUFxdMbGb) に参加するか、`community-only` のない Issue を選択してください。

### 4. 必要に応じて担当を解除

Issue に取り組めなくなった場合は、`/unclaim` とコメントして、他の人のために解放してください。

### 5. 貢献のチェックボックス

Issue を作成する際、「I am willing to contribute code」チェックボックスをオンにして、機能の実装や修正に興味があることを示すことができます。

---

## 開発環境のセットアップ

### 依存関係のインストール

```bash
bun install
```

### 利用可能なコマンド

| コマンド              | 説明                                      |
| --------------------- | ----------------------------------------- |
| `bun run dev`         | Chrome 開発モードを開始（ホットリロード） |
| `bun run dev:firefox` | Firefox 開発モードを開始                  |
| `bun run dev:safari`  | Safari 開発モードを開始（macOS のみ）     |
| `bun run build`       | Chrome 用のプロダクションビルド           |
| `bun run build:edge`  | Edge の独立ビルドとパッケージ作成         |
| `bun run build:all`   | Chrome + Firefox + Safari のビルド        |
| `bun run lint`        | ESLint を実行して自動修正                 |
| `bun run typecheck`   | TypeScript の型チェックを実行             |
| `bun run test`        | テストスイートを実行                      |
| `bun run verify:pr`   | 標準のローカル PR 自動検証                |

### 拡張機能の読み込み

1. `bun run dev` を実行して開発ビルドを開始します
2. Chrome を開き、`chrome://extensions/` に移動します
3. 「デベロッパー モード」を有効にします
4. 「パッケージ化されていない拡張機能を読み込む」をクリックし、`dist_chrome_dev` フォルダを選択します

---

## 変更の実施

### 作業を始める前に

1. `main` から**ブランチを作成**します：

   ```bash
   git checkout -b feature/your-feature-name
   # または
   git checkout -b fix/your-bug-fix
   ```

2. **Issue をリンクする** - 新機能の実装については、**まず議論のために Issue を提出する必要があります**。事前の議論なしに提出された新機能の PR はクローズされます。PR を送信する際は、その Issue をリンクしてください。

3. **変更を集中させる** - PR ごとに1つの機能または修正

### コミット前チェックリスト

送信する前に、必ず以下を実行してください：

```bash
bun run format     # コードの整形
bun run lint       # リンティングの問題を修正
bun run verify:pr  # 標準のローカル検証を実行
```

以下を確認してください：

1. 変更内容が期待通りに機能すること。
2. 既存の機能に影響を与えていないこと。

---

## テスト戦略

最も回帰しやすいインターフェースを検証してください。ロジックと複雑な状態は自動化し、セレクターや SPA ナビゲーションの変更には最小限の DOM テストを追加し、実際に拡張機能を読み込んでフローを確認します。

---

## Pull Request の送信

### PR ガイドライン

1. **タイトル**: 明確で説明的なタイトルを使用してください（例："feat: add dark mode toggle" または "fix: timeline scroll sync"）
2. **説明**: どのような変更を行ったか、およびその理由を説明してください
3. **ユーザーへの影響**: ユーザーにどのような影響があるかを説明してください
4. **視覚的証拠 (厳格)**: UI の変更や新機能については、**必ず**スクリーンショットまたは画面録画を提供してください。**スクリーンショットなし = レビュー/返信しません。**
5. **Issue の参照**: 関連する Issue をリンクしてください（例："Closes #123"）

### コミットメッセージの形式

[Conventional Commits](https://www.conventionalcommits.org/) に従ってください：

- `feat:` - 新機能
- `fix:` - バグ修正
- `docs:` - ドキュメントの変更
- `chore:` - メンテナンス作業
- `refactor:` - コードのリファクタリング
- `test:` - テストの追加または更新

---

## コードスタイル

### 一般的なガイドライン

- ネストされた条件分岐よりも**早期リターンを優先**
- **説明的な名前を使用** - 略語は避ける
- **マジックナンバーを避ける** - 名前付き定数を使用
- **既存のスタイルに合わせる** - 好みよりも一貫性

### TypeScript の規約

- **PascalCase**: クラス、インターフェース、型、Enum、React コンポーネント
- **camelCase**: 関数、変数、メソッド
- **UPPER_SNAKE_CASE**: 定数

### インポートの順序

1. React および関連するインポート
2. サードパーティライブラリ
3. 内部の絶対インポート（`@/...`）
4. 相対インポート（`./...`）
5. 型のみのインポート

```typescript
import React, { useState } from 'react';

import { marked } from 'marked';

import { Button } from '@/components/ui/Button';
import { StorageService } from '@/core/services/StorageService';
import type { FolderData } from '@/core/types/folder';

import { parseData } from './parser';
```

---

## Gem サポートの追加

新しい Gem（公式 Google Gems またはカスタム Gems）のサポートを追加するには：

1. `src/pages/content/folder/gemConfig.ts` を開きます
2. `GEM_CONFIG` 配列に新しいエントリを追加します：

```typescript
{
  id: 'your-gem-id',           // URL から取得: /gem/your-gem-id/...
  name: 'Your Gem Name',       // 表示名
  icon: 'material_icon_name',  // Google Material Symbols アイコン
}
```

### Gem ID の見つけ方

- Gem との会話を開きます
- URL を確認します: `https://gemini.google.com/app/gem/[GEM_ID]/...`
- 設定で `[GEM_ID]` の部分を使用します

### アイコンの選択

有効な [Google Material Symbols](https://fonts.google.com/icons) アイコン名を使用してください：

| アイコン       | 使用例               |
| -------------- | -------------------- |
| `auto_stories` | 学習、教育           |
| `lightbulb`    | アイデア、ブレスト   |
| `work`         | キャリア、専門職     |
| `code`         | プログラミング、技術 |
| `analytics`    | データ、分析         |

---

## プロジェクトの範囲

Voyager は、以下の機能で Gemini AI チャット体験を向上させます：

- タイムラインナビゲーション
- フォルダ整理
- プロンプトヴォルト
- チャットのエクスポート
- UI カスタマイズ

> [!NOTE]
> **Voyager の機能セットはすでに十分に充実していると考えています。** ニッチすぎる、あるいは過度に個人的な機能を追加しても、ソフトウェアの改善にはつながらず、メンテナンスの負担が増えるだけです。その機能が本当に必要不可欠で、大多数のユーザーにとって有益であると確信できない限り、Feature Request の送信を再検討してください。

**範囲外**: サイトのスクレイピング、ネットワーク傍受、アカウントの自動化。

---

## ヘルプを得る

- 💬 [GitHub Discussions](https://github.com/Nagi-ovo/voyager/discussions) - 質問する
- 🐛 [Issues](https://github.com/Nagi-ovo/voyager/issues) - バグを報告する
- 📖 [ドキュメント](https://voyager.nagi.fun/) - ドキュメントを読む

---

## ライセンス

貢献することにより、あなたの貢献が [GPLv3 ライセンス](../LICENSE) の下でライセンスされることに同意したものとみなされます。
