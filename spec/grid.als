// grid.als — グリッドエディタのデータモデルの構造仕様
//
// src/model/invariants.ts の I1〜I7 と対応する。TypeScript 実装が正であり、
// このファイルは設計探索(「この不変条件の組で変なインスタンスが作れないか」)
// のためのドキュメント。Alloy Analyzer 6 で open して run/check を実行する。
//
// モデル化の要点:
// - 行・列は安定ID(Row/Colシグネチャ)で表し、表示順は seq で持つ
// - セル内容は Row×Col の部分写像
// - 結合はIDの対角ペアで表し、被覆範囲は順序から導出する

module grid

open util/ordering[RowSlot] as ro
open util/ordering[ColSlot] as co

// 表示上のスロット(インデックス)。順序は ordering が与える
sig RowSlot {}
sig ColSlot {}

// 安定ID。各IDはちょうど1つのスロットを占める
sig Row { rowSlot: one RowSlot }
sig Col { colSlot: one ColSlot }

fact SlotsAreBijective {
  // I2 相当: IDとスロットは1対1
  all s: RowSlot | one rowSlot.s
  all s: ColSlot | one colSlot.s
}

// セル内容(存在すれば内容がある、という抽象化)
sig Content { at: one Row, atCol: one Col }

fact OneContentPerCell {
  // 同じ座標に複数の内容は置けない
  all disj a, b: Content | a.at != b.at or a.atCol != b.atCol
}

// 結合矩形: 対角のIDペア
sig Merge {
  r0: one Row, c0: one Col,
  r1: one Row, c1: one Col,
}

// スロットの区間包含
pred rowLte[a, b: Row] { ro/lte[a.rowSlot, b.rowSlot] }
pred colLte[a, b: Col] { co/lte[a.colSlot, b.colSlot] }

// 結合 m が座標 (r, c) を被覆するか
pred covers[m: Merge, r: Row, c: Col] {
  rowLte[m.r0, r] and rowLte[r, m.r1] and
  colLte[m.c0, c] and colLte[c, m.c1]
}

pred isAnchor[m: Merge, r: Row, c: Col] { m.r0 = r and m.c0 = c }

fact MergeWellFormed {
  // I5: 左上 <= 右下、かつ面積 >= 2セル
  all m: Merge {
    rowLte[m.r0, m.r1]
    colLte[m.c0, m.c1]
    not (m.r0 = m.r1 and m.c0 = m.c1)
  }
}

fact MergesDisjoint {
  // I6: 結合どうしは重ならない
  all disj m, n: Merge | no r: Row, c: Col | covers[m, r, c] and covers[n, r, c]
}

fact CoveredCellsEmpty {
  // I7: 非アンカー被覆セルは内容を持たない
  all x: Content | no m: Merge |
    covers[m, x.at, x.atCol] and not isAnchor[m, x.at, x.atCol]
}

// ---- 検証 ----

// アンカーは常に一意の結合に属する(重複被覆がないことの帰結)
assert AnchorUnique {
  all r: Row, c: Col | lone m: Merge | covers[m, r, c]
}
check AnchorUnique for 6

// 内容を持つセルは、結合に属さないか結合のアンカーである
assert ContentIsFreeOrAnchor {
  all x: Content | all m: Merge |
    covers[m, x.at, x.atCol] implies isAnchor[m, x.at, x.atCol]
}
check ContentIsFreeOrAnchor for 6

// 興味深いインスタンスの探索: 結合が2つ以上あり内容もあるグリッド
run ShowInteresting {
  #Merge >= 2 and #Content >= 2 and #Row >= 3 and #Col >= 3
} for 6
