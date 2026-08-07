// グリッドエディタのコアモデル。
// 設計判断: 行・列は安定IDで管理する。セル・結合・数式参照はすべてIDで
// 紐づくため、行列の挿入・削除時に参照の書き換えが不要になる。
// 表示上の位置(A1形式など)は rows/cols 配列のインデックスから毎回導出する。

export type RowId = string; // 例: "r3"
export type ColId = string; // 例: "c7"

/** cells のキー。`${RowId}:${ColId}` */
export type CellKey = string;

export interface CellAddr {
  row: RowId;
  col: ColId;
}

export function cellKey(addr: CellAddr): CellKey {
  return `${addr.row}:${addr.col}`;
}

export function parseCellKey(key: CellKey): CellAddr {
  const i = key.indexOf(":");
  return { row: key.slice(0, i), col: key.slice(i + 1) };
}

export interface RowMeta {
  id: RowId;
  height: number;
}

export interface ColMeta {
  id: ColId;
  width: number;
}

// ---- 数式 AST ----
// 参照はIDで保持する。参照先の行/列が削除されても AST は書き換えず、
// 評価時・表示時に #REF! として扱う(ダングリング参照は仕様上許容)。

export type Expr =
  | { type: "num"; value: number }
  | { type: "ref"; row: RowId; col: ColId }
  | { type: "refError" } // 入力時点で範囲外だった参照
  | { type: "neg"; expr: Expr }
  | { type: "bin"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr }
  | { type: "sum"; range: RangeRef };

export interface RangeRef {
  r0: RowId;
  c0: ColId;
  r1: RowId;
  c1: ColId;
}

export type CellContent =
  | { kind: "text"; text: string }
  | { kind: "formula"; ast: Expr };

// ---- 結合セル ----
// 矩形の対角をIDで保持する(r0/c0 が左上=アンカー、r1/c1 が右下)。
// 被覆範囲は「インデックス上で対角の間にある行×列」として導出されるため、
// 範囲内への行列挿入は自動的に結合を押し広げる(Excelと同じ挙動)。

export interface MergeRect {
  r0: RowId;
  c0: ColId;
  r1: RowId;
  c1: ColId;
}

// ---- ドキュメント(undo対象) ----

export interface GridDoc {
  rows: RowMeta[];
  cols: ColMeta[];
  cells: Record<CellKey, CellContent>;
  merges: MergeRect[];
  /** ID生成用の単調増加カウンタ。reducerを純粋関数に保つためstateに持つ */
  idCounter: number;
}

// ---- UI状態(undo対象外) ----

export interface Selection {
  /** 選択の基点。常に「自由セルまたは結合アンカー」に正規化される */
  anchor: CellAddr;
  /** 選択の到達点。同上 */
  focus: CellAddr;
}

export interface EditingState {
  addr: CellAddr;
  draft: string;
}

export interface GridState {
  doc: GridDoc;
  selection: Selection | null;
  editing: EditingState | null;
  past: GridDoc[];
  future: GridDoc[];
}

export const MIN_ROW_HEIGHT = 12;
export const MIN_COL_WIDTH = 24;
export const MAX_HISTORY = 100;

// ---- 導出ヘルパ(モデルを読むだけの純関数) ----

// ID→インデックスは全域から呼ばれる基盤なので、doc ごとに Map を1回だけ
// 構築して WeakMap にキャッシュする(doc はイミュータブルなので安全)。
const indexCache = new WeakMap<
  GridDoc,
  { row: Map<RowId, number>; col: Map<ColId, number> }
>();

function docIndexes(doc: GridDoc) {
  let entry = indexCache.get(doc);
  if (!entry) {
    entry = {
      row: new Map(doc.rows.map((r, i) => [r.id, i])),
      col: new Map(doc.cols.map((c, i) => [c.id, i])),
    };
    indexCache.set(doc, entry);
  }
  return entry;
}

export function rowIndex(doc: GridDoc, id: RowId): number {
  return docIndexes(doc).row.get(id) ?? -1;
}

export function colIndex(doc: GridDoc, id: ColId): number {
  return docIndexes(doc).col.get(id) ?? -1;
}

/** ID対角の矩形(結合・数式レンジ共通の形)をインデックス範囲に解決する。
 *  角のIDが消えていたら null */
export function rectBounds(
  doc: GridDoc,
  rect: { r0: RowId; c0: ColId; r1: RowId; c1: ColId },
): { r0: number; c0: number; r1: number; c1: number } | null {
  const r0 = rowIndex(doc, rect.r0);
  const r1 = rowIndex(doc, rect.r1);
  const c0 = colIndex(doc, rect.c0);
  const c1 = colIndex(doc, rect.c1);
  if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) return null;
  return { r0, c0, r1, c1 };
}

/** addr を被覆している結合を返す(アンカー自身も「被覆」に含む) */
export function mergeAt(doc: GridDoc, addr: CellAddr): MergeRect | null {
  const ri = rowIndex(doc, addr.row);
  const ci = colIndex(doc, addr.col);
  if (ri < 0 || ci < 0) return null;
  for (const m of doc.merges) {
    const b = rectBounds(doc, m);
    if (b && b.r0 <= ri && ri <= b.r1 && b.c0 <= ci && ci <= b.c1) return m;
  }
  return null;
}

/** addr が結合の非アンカー被覆セルか */
export function isCoveredCell(doc: GridDoc, addr: CellAddr): boolean {
  const m = mergeAt(doc, addr);
  return m !== null && !(m.r0 === addr.row && m.c0 === addr.col);
}
