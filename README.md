# AI Model Comparison Dashboard

OpenAI・Anthropic・Google を中心に、主要 LLM の **API 料金・ベンチマークスコア・速度** を 1 画面で比べる静的サイトです。
モデルを 1 つ「基準」に選ぶと、全モデルの値を基準 = 1.00× の倍率で表示します。仕様は [AI_Model_Comparison_Dashboard_Spec.md](AI_Model_Comparison_Dashboard_Spec.md)。

- 価格 vs スコアの散布図（絶対値 / 基準比、X 対数、パレート線、クリックで基準変更）
- 相対比較表（ソート、基準行の固定、CSV 出力）
- 入力・出力トークン数を変えると想定コストと倍率をその場で再計算
- 絞り込み条件・基準・指標・表示モードは URL に入るので、そのまま共有できる

## データの流れ

```
GitHub Actions (毎日 / 手動)
  └ scripts/update-data.mjs
      ├ GET /api/v1/models                     … 公開。価格・コンテキスト長など
      ├ GET /api/v1/benchmarks?source=…        … 要 API キー。Artificial Analysis 指標、OpenRouter 自前評価
      └ GET /api/v1/models/{id}/endpoints      … 要 API キー。直近 30 分の速度・遅延 (p50。遅延はミリ秒で返るので秒に直す)
  → public/data/catalog.json をコミット → Pages を再デプロイ
ブラウザ
  └ data/catalog.json を読むだけ（キーも外部 API 呼び出しも無し）
```

- API キーは GitHub Secrets から Actions の中でだけ使い、出力ファイルにもログにも書きません。
- 取得に失敗したら前回の正常なファイルを残します（空で上書きしない）。ベンチマークだけ失敗した場合は `public/data/benchmarks.json` の前回値を使い、画面に「前回値」と出します。
- ベンチマークは `model_permaslug` を Models API の `canonical_slug` → `id` の順で照合します。表示名では照合しません。
- 指標は「出典 + 指標名 + 版」ごとに別の軸として扱い、合成しません。

## ローカルで動かす

```bash
npm install
npm run dev          # http://localhost:5173/
npm test             # 計算・正規化の単体テスト
npm run build        # dist/ に出力
```

データを取り直すとき（キーが無ければ価格だけ取得します）:

```bash
OPENROUTER_API_KEY=sk-or-... npm run update-data
```

キーが無くても見た目を確かめられるよう、架空の値の `public/data/sample.catalog.json` を同梱しています。`?data=sample` を付けると読み込み、画面上部に「サンプルデータ」と表示します。

## GitHub Pages の設定

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする。
2. **Settings → Secrets and variables → Actions → New repository secret** で `OPENROUTER_API_KEY` を登録する（[OpenRouter のキー](https://openrouter.ai/settings/keys)。どの有効なキーでも可。読み取りにしか使わないので Credit limit は少額でよい）。
3. **Actions → Update model data → Run workflow** で初回取得。以後は毎日 06:17 JST に自動更新。
4. `main` に push すると `Deploy to GitHub Pages` が走り、`https://<user>.github.io/<repo>/` に公開されます。Vite の `base: './'` で相対パスにしているので、サブパスでもそのまま動きます。

## 計算

| 値 | 式 |
|---|---|
| 想定コスト | 入力単価 × 入力トークン ÷ 100万 + 出力単価 × 出力トークン ÷ 100万 |
| スコア比 / コスト比 / 速度比 / 遅延比 | 対象 ÷ 基準 |
| コスト効率比 | (スコア ÷ 想定コスト) の基準比。想定コスト 0 は定義しない |
| パレート最適 | スコアが同等以上・コストが同等以下で、どちらかが厳密に良い他モデルが無い |

基準の値が 0 や不明のときは N/A（Infinity / NaN は出しません）。キャッシュ・Web 検索・ツール・画像音声・長文割増の料金は含みません。

## 出典とライセンス

- モデル・価格・ベンチマーク: [OpenRouter](https://openrouter.ai/)。Data API の公開データは CC BY 4.0。
- Artificial Analysis 指標: [Artificial Analysis](https://artificialanalysis.ai/)。再掲時は出典を表示します。
- コード: [LICENSE](LICENSE)
