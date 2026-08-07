# grid-editor

Excel的なグリッドエディタ。SVG + [@chenglou/pretext](https://github.com/chenglou/pretext)(DOM計測なしのテキストレイアウト)で描画する。

機能: セル編集、数式(`=A1+B2*2`、`=SUM(A1:B3)`、循環参照検出)、セル結合、行列の挿入・削除・リサイズ、undo/redo、キーボード操作。

```sh
pnpm install
pnpm dev    # 開発サーバ
pnpm test   # ユニット + property-based テスト
pnpm lint
```

## アーキテクチャ

「モデル → 不変条件 → アクション → reducer → テスト → レンダラ」の順に作られており、
レイヤの依存は一方向のみ:

```
view(React+SVG+pretext) ──▶ model(純TS) ◀── formula(パーサ・評価器)
                              ▲
     spec/grid.als(Alloy) ────┘ 不変条件の構造仕様(ドキュメント)
```

### 中心的な設計判断: 行・列は安定ID

`GridDoc` の行・列は `r12` / `c34` のような**安定ID**を持ち、表示位置は配列の
インデックスから毎回導出する。セル(`cells` のキー)、結合矩形の角、数式の参照は
すべてIDで紐づく。この結果:

- 行列の挿入・削除は配列操作だけで済み、セルや参照の「付け替え」が存在しない
- 数式参照(`=A1`)は入力時にIDへ解決され、以後は行が移動しても自動追従する。
  参照先が削除されたら `#REF!`(仕様として許容されるダングリング)
- 結合矩形は角2つのIDだけ持ち、範囲内への挿入は自動的に結合を押し広げる

### 不変条件(I1〜I10)

`src/model/invariants.ts` が唯一の定義。同じ構造仕様を `spec/grid.als`
(Alloy 6)としても記述してあり、設計変更時は Alloy Analyzer で
「変なインスタンスが作れないか」を探索できる。

### reducer の契約

`src/model/reducer.ts` の `reduce(state, action)` は:

1. 引数を一切ミューテートしない
2. **どんな不正なアクション(存在しないID・範囲外の値)でも状態を壊さず no-op**
3. `doc` が変わるアクションだけ履歴(スナップショット方式)に積む

### テスト戦略(TLA+ の代替)

`src/model/properties.test.ts` が fast-check でランダムな(しばしば不正な)
アクション列を実 reducer に流し、以下を検証する。実装そのものに対する
モデル検査に相当し、仕様と実装の乖離が原理的に起きない:

- P1: 全ステップで不変条件 I1〜I10 が保たれる
- P2: deep-freeze による非ミューテーション検証
- P3: 全undoで履歴が正確に巻き戻り、全redoで完全復元される(参照一致)
- P4: 数式評価は例外を投げず決定的

### レンダラ

`src/view/` は state を描画するだけの薄い層。SVG の `<text>` は折り返しを
しないため、pretext で行分割を計算し `<tspan>` を配置する(`CellText.tsx`)。
行列リサイズのドラッグ中はローカル state でプレビューし、確定時のみ
dispatch することで undo 履歴を汚さない。
