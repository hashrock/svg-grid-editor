import type { CellAddr, ColId, RowId } from "./types";

// reducer への入力。すべてのアクションは「不正な引数(存在しないID、
// 範囲外インデックスなど)に対して状態を壊さず no-op になる」ことを
// 契約とする。これにより property-based test のジェネレータは
// 雑な値を投げてよく、堅牢性そのものが検証対象になる。

export type Action =
  // セル内容
  | { type: "setCell"; addr: CellAddr; raw: string }
  | { type: "clearRange"; anchor: CellAddr; focus: CellAddr }
  // 選択
  | { type: "setSelection"; anchor: CellAddr; focus: CellAddr }
  | { type: "clearSelection" }
  | { type: "moveSelection"; dRow: number; dCol: number; extend: boolean }
  // 編集モード
  | { type: "startEdit"; draft?: string; where?: "cell" | "bar" }
  // 入力欄の現在値をそのまま渡す。非編集中なら選択セルの編集を開始する。
  // ビュー側が「編集中かどうか」を判断せずに済むので、高速入力で状態の
  // 読み取りが古くなっても文字が落ちない
  | { type: "setDraft"; draft: string }
  | { type: "commitEdit" }
  | { type: "cancelEdit" }
  // 行・列。挿入・削除とも選択範囲ぶんをまとめて1操作として扱う
  // (履歴にも1手として積まれる)
  | { type: "insertRow"; index: number; count?: number }
  | { type: "insertCol"; index: number; count?: number }
  | { type: "deleteRows"; ids: RowId[] }
  | { type: "deleteCols"; ids: ColId[] }
  | { type: "resizeRow"; id: RowId; height: number }
  | { type: "resizeCol"; id: ColId; width: number }
  // 結合
  | { type: "merge"; anchor: CellAddr; focus: CellAddr }
  | { type: "unmerge"; addr: CellAddr }
  // 履歴
  | { type: "undo" }
  | { type: "redo" };
