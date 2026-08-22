# Warun Tab Order — Typography System

この文書は、10インチ横向き（1280 × 800 CSS px、ズーム100%）で表示する試作UIのTypography基準です。既存の朱色・生成り・黒の和モダン構成と、厨房で一瞬で読める強い文字階層を維持します。

## 使用フォント

本番UIは外部CDNやOSインストール済みフォントに依存せず、`prototype/assets/fonts/` のローカル資産を使用します。

- 日本語UI：`Warun JP` → `NotoSansJP-VF.ttf`（weight 100〜900）
- 数字・英字アクセント：`Warun Display` → `Oswald-VF.ttf`（weight 200〜700）
- 外部Google Fonts、OS依存の `Yu Gothic` / `Meiryo` / `BIZ UDPGothic` へのフォールバックは使用しない

Oswaldは公式Google Fontsリポジトリ由来のローカル資産として同梱し、実行時に外部CDNへ接続しません。

## Token

```css
:root {
  --font-ui: "Warun JP", sans-serif;
  --font-display: "Warun Display", "Warun JP", sans-serif;
  --text-xs: 18px;
  --text-sm: 18px;
  --text-md: 20px;
  --text-lg: 22px;
  --text-xl: 28px;
  --text-2xl: 40px;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-bold: 700;
  --weight-black: 900;
  --line-tight: 1.15;
  --line-normal: 1.45;
  --line-relaxed: 1.65;
}
```

## 適用ルール

- 日本語の本文・品名・カテゴリ・ボタンは`Warun JP`を使う。
- 品名と厨房操作はweight 700以上、テーブル番号・数量・時刻はweight 700〜900にする。
- 金額、番号、英字ラベルは`Warun Display`を使い、画面全体で同じ数字の骨格を保つ。
- 本文のline-heightは1.45、見出しは1.15、説明文は1.45〜1.65を基本にする。
- letter-spacingは日本語で0〜0.02em、英字ラベルで0.04〜0.1emの範囲に限定する。
- フォント変更後は文字幅、ボタン幅、カード高、行高、折り返し、注文概要高を1280 × 800で確認する。
- 厨房画面は細字を使わず、未提供品・数量・チェック領域の視認性を最優先する。

## 検証

ローカルWebでDevToolsのRendered Fontsを確認し、日本語UIが`Warun JP`、数字・英字アクセントが`Warun Display`で描画されていることを確認します。Android WebViewではフォント読込完了、文字化け、数字の幅、ボタン内の折り返しを実機相当画面で再確認します。

Typography作業では、アプリ挙動、API、DB、認証、注文永続化、SSE、idempotency、業務ロジックを変更しません。
