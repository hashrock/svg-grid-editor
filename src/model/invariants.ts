// モデルの不変条件。spec/grid.als の Alloy 仕様と1対1対応させている。
// reducer がどんなアクション列を処理しても checkInvariants が空配列を
// 返すことを、property-based test で検証する。

import {
  type CellAddr,
  type CellKey,
  type GridDoc,
  type GridState,
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  cellKey,
  isCoveredCell,
  rectBounds,
  parseCellKey,
  rowIndex,
  colIndex,
} from "./types";

export function checkDocInvariants(doc: GridDoc): string[] {
  const errors: string[] = [];

  // I1: グリッドは空にならない
  if (doc.rows.length === 0) errors.push("I1: rows must not be empty");
  if (doc.cols.length === 0) errors.push("I1: cols must not be empty");

  // I2: 行・列IDは一意
  const rowIds = new Set(doc.rows.map((r) => r.id));
  const colIds = new Set(doc.cols.map((c) => c.id));
  if (rowIds.size !== doc.rows.length) errors.push("I2: duplicate row ids");
  if (colIds.size !== doc.cols.length) errors.push("I2: duplicate col ids");

  // I3: サイズは最小値以上
  for (const r of doc.rows) {
    if (r.height < MIN_ROW_HEIGHT) errors.push(`I3: row ${r.id} height ${r.height} < min`);
  }
  for (const c of doc.cols) {
    if (c.width < MIN_COL_WIDTH) errors.push(`I3: col ${c.id} width ${c.width} < min`);
  }

  // I4: 全セルの行・列IDが存在する
  for (const key of Object.keys(doc.cells)) {
    const addr = parseCellKey(key);
    if (!rowIds.has(addr.row) || !colIds.has(addr.col)) {
      errors.push(`I4: cell ${key} references missing row/col`);
    }
  }

  // I5: 結合矩形の整合性 — 角のIDが存在し、左上<=右下、面積>=2セル
  const boundsList: { r0: number; c0: number; r1: number; c1: number }[] = [];
  for (const m of doc.merges) {
    const b = rectBounds(doc, m);
    if (!b) {
      errors.push(`I5: merge ${JSON.stringify(m)} has missing corner ids`);
      continue;
    }
    if (b.r0 > b.r1 || b.c0 > b.c1) {
      errors.push(`I5: merge ${JSON.stringify(m)} corners out of order`);
    }
    if (b.r1 - b.r0 === 0 && b.c1 - b.c0 === 0) {
      errors.push(`I5: merge ${JSON.stringify(m)} covers a single cell`);
    }
    boundsList.push(b);
  }

  // I6: 結合矩形どうしは重ならない
  for (let i = 0; i < boundsList.length; i++) {
    for (let j = i + 1; j < boundsList.length; j++) {
      const a = boundsList[i];
      const b = boundsList[j];
      const overlap =
        a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
      if (overlap) errors.push(`I6: merges ${i} and ${j} overlap`);
    }
  }

  // I7: 結合の非アンカー被覆セルは内容を持たない
  // (I5で解決済みの boundsList から被覆セル集合を一度だけ構築して照合する)
  const coveredKeys = new Set<CellKey>();
  for (const b of boundsList) {
    for (let ri = Math.min(b.r0, b.r1); ri <= Math.max(b.r0, b.r1); ri++) {
      for (let ci = Math.min(b.c0, b.c1); ci <= Math.max(b.c0, b.c1); ci++) {
        if (ri === b.r0 && ci === b.c0) continue; // アンカーは内容を持ってよい
        coveredKeys.add(cellKey({ row: doc.rows[ri].id, col: doc.cols[ci].id }));
      }
    }
  }
  for (const key of Object.keys(doc.cells)) {
    if (coveredKeys.has(key)) errors.push(`I7: covered cell ${key} has content`);
  }

  // I8: idCounter は既存IDの数値サフィックスより大きい(将来の衝突防止)
  for (const id of [...rowIds, ...colIds]) {
    const n = Number(id.slice(1));
    if (Number.isFinite(n) && n >= doc.idCounter) {
      errors.push(`I8: id ${id} >= idCounter ${doc.idCounter}`);
    }
  }

  return errors;
}

function checkAddr(doc: GridDoc, addr: CellAddr, label: string): string[] {
  const errors: string[] = [];
  if (rowIndex(doc, addr.row) < 0 || colIndex(doc, addr.col) < 0) {
    errors.push(`${label}: references missing row/col ${JSON.stringify(addr)}`);
    return errors;
  }
  // 選択・編集位置は「自由セルまたは結合アンカー」に正規化されている
  if (isCoveredCell(doc, addr)) {
    errors.push(`${label}: points at covered cell ${JSON.stringify(addr)}`);
  }
  return errors;
}

export function checkInvariants(state: GridState): string[] {
  const errors = checkDocInvariants(state.doc);

  // I9: 選択の anchor/focus は存在するセルで、被覆セルを指さない
  if (state.selection) {
    errors.push(...checkAddr(state.doc, state.selection.anchor, "I9 anchor"));
    errors.push(...checkAddr(state.doc, state.selection.focus, "I9 focus"));
  }

  // I10: 編集位置も同様
  if (state.editing) {
    errors.push(...checkAddr(state.doc, state.editing.addr, "I10 editing"));
  }

  return errors;
}
