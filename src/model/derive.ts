// モデルから導出する読み取り専用の計算(ビューとreducerの両方から使える)

import {
  type CellAddr,
  type GridDoc,
  type MergeRect,
  type Selection,
  cellKey,
  colIndex,
  rectBounds,
  rowIndex,
} from "./types";
import { formatExpr } from "../formula/parse";

export interface IndexRect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function rectsIntersect(a: IndexRect, b: IndexRect): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

/** 2つのアドレスを正規化した min/max 矩形に解決する。どちらかが消えていたら null */
export function rectFromAddrs(doc: GridDoc, a: CellAddr, b: CellAddr): IndexRect | null {
  const ra = rowIndex(doc, a.row);
  const rb = rowIndex(doc, b.row);
  const ca = colIndex(doc, a.col);
  const cb = colIndex(doc, b.col);
  if (ra < 0 || rb < 0 || ca < 0 || cb < 0) return null;
  return {
    r0: Math.min(ra, rb),
    c0: Math.min(ca, cb),
    r1: Math.max(ra, rb),
    c1: Math.max(ca, cb),
  };
}

/**
 * 矩形を、交差する結合をすべて含むまで拡張する(Excelの選択挙動)。
 * 拡張で新たな交差が生まれうるので固定点まで繰り返す。
 * absorbed には交差した(=拡張後の矩形に完全に含まれる)結合が入る。
 */
export function expandRectOverMerges(
  doc: GridDoc,
  rect: IndexRect,
): { rect: IndexRect; absorbed: Set<MergeRect> } {
  const absorbed = new Set<MergeRect>();
  for (;;) {
    let grew = false;
    for (const m of doc.merges) {
      if (absorbed.has(m)) continue;
      const b = rectBounds(doc, m);
      if (!b || !rectsIntersect(rect, b)) continue;
      absorbed.add(m);
      const grown: IndexRect = {
        r0: Math.min(rect.r0, b.r0),
        c0: Math.min(rect.c0, b.c0),
        r1: Math.max(rect.r1, b.r1),
        c1: Math.max(rect.c1, b.c1),
      };
      if (
        grown.r0 !== rect.r0 ||
        grown.c0 !== rect.c0 ||
        grown.r1 !== rect.r1 ||
        grown.c1 !== rect.c1
      ) {
        rect = grown;
        grew = true;
      }
    }
    if (!grew) return { rect, absorbed };
  }
}

/** anchor..focus の選択矩形(結合を含むまで拡張済み) */
export function selectionRect(doc: GridDoc, sel: Selection): IndexRect | null {
  const base = rectFromAddrs(doc, sel.anchor, sel.focus);
  return base && expandRectOverMerges(doc, base).rect;
}

/** 選択範囲に含まれる行ID。ツールバーの「行削除」の対象＝画面で光っている行 */
export function selectedRowIds(doc: GridDoc, sel: Selection): string[] {
  const rect = selectionRect(doc, sel);
  return rect ? doc.rows.slice(rect.r0, rect.r1 + 1).map((r) => r.id) : [];
}

/** 選択範囲に含まれる列ID */
export function selectedColIds(doc: GridDoc, sel: Selection): string[] {
  const rect = selectionRect(doc, sel);
  return rect ? doc.cols.slice(rect.c0, rect.c1 + 1).map((c) => c.id) : [];
}

/** セルの編集用・表示用のraw文字列。数式は現在位置のA1形式で再生成する */
export function cellRawString(doc: GridDoc, addr: CellAddr): string {
  const content = doc.cells[cellKey(addr)];
  if (!content) return "";
  return content.kind === "text" ? content.text : `=${formatExpr(doc, content.ast)}`;
}
