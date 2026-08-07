// 純粋な reducer: (GridState, Action) => GridState
// 契約:
// - 引数を一切ミューテートしない
// - 不正な引数(存在しないID、範囲外インデックス等)は状態を変えず no-op
// - doc が変化するアクションのみ履歴に積む(選択・編集は undo 対象外)
// - 編集の「離脱」は reducer が所有する: 選択が動くとき、進行中の編集は
//   自動的にコミットされる(ビュー側の呼び分けに依存しない)

import type { Action } from "./actions";
import { parseFormula } from "../formula/parse";
import {
  type CellAddr,
  type CellContent,
  type CellKey,
  type ColMeta,
  type GridDoc,
  type GridState,
  type MergeRect,
  type RowMeta,
  type Selection,
  MAX_HISTORY,
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  cellKey,
  parseCellKey,
  colIndex,
  mergeAt,
  rectBounds,
  rowIndex,
} from "./types";
import { cellRawString, expandRectOverMerges, rectFromAddrs } from "./derive";

export const DEFAULT_ROW_HEIGHT = 28;
export const DEFAULT_COL_WIDTH = 96;

// ---- 初期状態 ----

export function createInitialState(numRows = 20, numCols = 8): GridState {
  let counter = 0;
  const rows = Array.from({ length: numRows }, () => ({
    id: `r${counter++}`,
    height: DEFAULT_ROW_HEIGHT,
  }));
  const cols = Array.from({ length: numCols }, () => ({
    id: `c${counter++}`,
    width: DEFAULT_COL_WIDTH,
  }));
  const doc: GridDoc = { rows, cols, cells: {}, merges: [], idCounter: counter };
  return {
    doc,
    selection: {
      anchor: { row: rows[0].id, col: cols[0].id },
      focus: { row: rows[0].id, col: cols[0].id },
    },
    editing: null,
    past: [],
    future: [],
  };
}

// ---- 内部ヘルパ ----

function addrExists(doc: GridDoc, addr: CellAddr): boolean {
  return rowIndex(doc, addr.row) >= 0 && colIndex(doc, addr.col) >= 0;
}

/** 被覆セルをその結合のアンカーに正規化する。存在しない addr は null */
function normalizeAddr(doc: GridDoc, addr: CellAddr): CellAddr | null {
  if (!addrExists(doc, addr)) return null;
  const m = mergeAt(doc, addr);
  if (m && !(m.r0 === addr.row && m.c0 === addr.col)) {
    return { row: m.r0, col: m.c0 };
  }
  return addr;
}

function sameAddr(a: CellAddr, b: CellAddr): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * doc 変更をまたいだアドレスの引き継ぎ。IDが生き残っていればそのまま、
 * 消えていれば「同じインデックス位置(クランプ)」の行・列に載せ替える。
 * 行削除後に選択が隣の行へ移る挙動(Excel準拠)はここから全アクションと
 * undo/redo に共通で効く。
 */
function relocateAddr(prev: GridDoc, next: GridDoc, addr: CellAddr): CellAddr | null {
  let { row, col } = addr;
  if (rowIndex(next, row) < 0) {
    const oldIdx = rowIndex(prev, row);
    if (oldIdx < 0) return null;
    row = next.rows[Math.min(oldIdx, next.rows.length - 1)].id;
  }
  if (colIndex(next, col) < 0) {
    const oldIdx = colIndex(prev, col);
    if (oldIdx < 0) return null;
    col = next.cols[Math.min(oldIdx, next.cols.length - 1)].id;
  }
  return normalizeAddr(next, { row, col });
}

/** doc 変更後に選択・編集を整合させる */
function fixupUi(
  prev: GridDoc,
  next: GridDoc,
  state: GridState,
): Pick<GridState, "selection" | "editing"> {
  let selection: Selection | null = null;
  if (state.selection) {
    const anchor = relocateAddr(prev, next, state.selection.anchor);
    const focus = relocateAddr(prev, next, state.selection.focus);
    if (anchor && focus) selection = { anchor, focus };
  }
  let editing = state.editing;
  if (editing) {
    const addr = normalizeAddr(next, editing.addr);
    if (!addr || !sameAddr(addr, editing.addr)) {
      editing = null; // 編集位置が消えた・被覆された場合は編集破棄
    }
  }
  return { selection, editing };
}

/** doc の変更を履歴に積んで新しい state を返す。doc 不変なら state をそのまま返す */
function commitDoc(state: GridState, doc: GridDoc): GridState {
  if (doc === state.doc) return state;
  return {
    ...state,
    doc,
    ...fixupUi(state.doc, doc, state),
    past: [...state.past.slice(-(MAX_HISTORY - 1)), state.doc],
    future: [],
  };
}

function setCellContent(doc: GridDoc, addr: CellAddr, raw: string): GridDoc {
  const key = cellKey(addr);
  if (raw === "") {
    if (!(key in doc.cells)) return doc;
    const cells = { ...doc.cells };
    delete cells[key];
    return { ...doc, cells };
  }
  let content: CellContent;
  if (raw.startsWith("=")) {
    const ast = parseFormula(doc, raw.slice(1));
    // パース失敗はテキストとして保存(Excelのようなエラーダイアログは出さない)
    content = ast ? { kind: "formula", ast } : { kind: "text", text: raw };
  } else {
    content = { kind: "text", text: raw };
  }
  return { ...doc, cells: { ...doc.cells, [key]: content } };
}

/** 進行中の編集をコミットする。編集がなければ state をそのまま返す */
function commitPendingEdit(state: GridState): GridState {
  if (!state.editing) return state;
  const { addr, draft } = state.editing;
  const next = commitDoc(state, setCellContent(state.doc, addr, draft));
  return { ...next, editing: null };
}

/** 矩形(インデックス範囲)内の全セルキーを列挙 */
function keysInRect(doc: GridDoc, rect: { r0: number; c0: number; r1: number; c1: number }): CellKey[] {
  const keys: CellKey[] = [];
  for (let ri = rect.r0; ri <= rect.r1; ri++) {
    for (let ci = rect.c0; ci <= rect.c1; ci++) {
      keys.push(cellKey({ row: doc.rows[ri].id, col: doc.cols[ci].id }));
    }
  }
  return keys;
}

/** 面積1以下になった結合を除去 */
function pruneDegenerateMerges(doc: GridDoc): GridDoc {
  const merges = doc.merges.filter((m) => {
    const b = rectBounds(doc, m);
    return b !== null && !(b.r0 === b.r1 && b.c0 === b.c1);
  });
  return merges.length === doc.merges.length ? doc : { ...doc, merges };
}

// ---- 行・列の軸抽象 ----
// 挿入・削除は行と列で完全に鏡写しなので、軸ごとの差分(配列の場所、
// 結合矩形の角のキー、セルキーのどちら側か)をアダプタに寄せて1実装にする。

interface AxisOps {
  lines(doc: GridDoc): { id: string }[];
  withLines(doc: GridDoc, lines: { id: string }[]): GridDoc;
  newLine(id: string): { id: string };
  idPrefix: string;
  index(doc: GridDoc, id: string): number;
  lo: "r0" | "c0";
  hi: "r1" | "c1";
  addrPart(addr: CellAddr): string;
  boundsLo(b: { r0: number; c0: number }): number;
  boundsHi(b: { r1: number; c1: number }): number;
}

const rowOps: AxisOps = {
  lines: (doc) => doc.rows,
  withLines: (doc, lines) => ({ ...doc, rows: lines as RowMeta[] }),
  newLine: (id) => ({ id, height: DEFAULT_ROW_HEIGHT }),
  idPrefix: "r",
  index: rowIndex,
  lo: "r0",
  hi: "r1",
  addrPart: (addr) => addr.row,
  boundsLo: (b) => b.r0,
  boundsHi: (b) => b.r1,
};

const colOps: AxisOps = {
  lines: (doc) => doc.cols,
  withLines: (doc, lines) => ({ ...doc, cols: lines as ColMeta[] }),
  newLine: (id) => ({ id, width: DEFAULT_COL_WIDTH }),
  idPrefix: "c",
  index: colIndex,
  lo: "c0",
  hi: "c1",
  addrPart: (addr) => addr.col,
  boundsLo: (b) => b.c0,
  boundsHi: (b) => b.c1,
};

function doInsertLines(
  state: GridState,
  ops: AxisOps,
  index: number,
  count = 1,
): GridState {
  const doc = state.doc;
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1) return state;
  const lines = ops.lines(doc);
  const at = Math.max(0, Math.min(lines.length, index));
  const added = Array.from({ length: count }, (_, i) =>
    ops.newLine(`${ops.idPrefix}${doc.idCounter + i}`),
  );
  const newLines = [...lines.slice(0, at), ...added, ...lines.slice(at)];
  return commitDoc(
    state,
    ops.withLines({ ...doc, idCounter: doc.idCounter + count }, newLines),
  );
}

/** 1本だけ削除した doc を返す純関数。削除できないときは doc をそのまま返す */
function removeLine(doc: GridDoc, ops: AxisOps, id: string): GridDoc {
  const lines = ops.lines(doc);
  if (ops.index(doc, id) < 0 || lines.length <= 1) return doc;

  // 結合の角が消える場合、角を生き残る側の行/列に付け替える。
  // この軸の幅が1の結合がその行/列ごと消える場合は結合ごと消す。
  const merges: MergeRect[] = [];
  for (const m of doc.merges) {
    const b = rectBounds(doc, m)!;
    if (ops.boundsLo(b) === ops.boundsHi(b) && m[ops.lo] === id) continue;
    let lo = m[ops.lo];
    let hi = m[ops.hi];
    if (lo === id) lo = lines[ops.boundsLo(b) + 1].id;
    if (hi === id) hi = lines[ops.boundsHi(b) - 1].id;
    merges.push(
      lo === m[ops.lo] && hi === m[ops.hi]
        ? m
        : ({ ...m, [ops.lo]: lo, [ops.hi]: hi } as MergeRect),
    );
  }

  const cells: Record<CellKey, CellContent> = {};
  for (const [key, content] of Object.entries(doc.cells)) {
    if (ops.addrPart(parseCellKey(key)) !== id) cells[key] = content;
  }
  const newLines = lines.filter((l) => l.id !== id);
  return pruneDegenerateMerges(ops.withLines({ ...doc, cells, merges }, newLines));
}

function doDeleteLines(state: GridState, ops: AxisOps, ids: string[]): GridState {
  const doc = state.doc;
  if (!Array.isArray(ids)) return state;
  const targets = [...new Set(ids)].filter((id) => ops.index(doc, id) >= 0);
  if (targets.length === 0) return state;
  // すべて消すとグリッドが空になる。最低1本は残す(I1)ため操作ごと拒否する
  if (targets.length >= ops.lines(doc).length) return state;

  // 1本ずつ畳み込むが commitDoc は最後に1回だけ = undo 1手で戻る。
  // 削除位置への選択の載せ替えは commitDoc → fixupUi の relocateAddr が行う
  let next = doc;
  for (const id of targets) next = removeLine(next, ops, id);
  return commitDoc(state, next);
}

function doResizeLine(state: GridState, axis: "row" | "col", id: string, size: number): GridState {
  const doc = state.doc;
  if (!Number.isFinite(size)) return state;
  if (axis === "row") {
    const idx = rowIndex(doc, id);
    if (idx < 0) return state;
    const height = Math.max(MIN_ROW_HEIGHT, Math.round(size));
    if (doc.rows[idx].height === height) return state;
    const rows = doc.rows.map((r) => (r.id === id ? { ...r, height } : r));
    return commitDoc(state, { ...doc, rows });
  }
  const idx = colIndex(doc, id);
  if (idx < 0) return state;
  const width = Math.max(MIN_COL_WIDTH, Math.round(size));
  if (doc.cols[idx].width === width) return state;
  const cols = doc.cols.map((c) => (c.id === id ? { ...c, width } : c));
  return commitDoc(state, { ...doc, cols });
}

// ---- 結合・選択 ----

function doMerge(state: GridState, a: CellAddr, b: CellAddr): GridState {
  const doc = state.doc;
  const base = rectFromAddrs(doc, a, b);
  if (!base) return state;
  const { rect, absorbed } = expandRectOverMerges(doc, base);
  if (rect.r0 === rect.r1 && rect.c0 === rect.c1) return state;

  const anchorKey = cellKey({ row: doc.rows[rect.r0].id, col: doc.cols[rect.c0].id });
  const cells: Record<CellKey, CellContent> = { ...doc.cells };
  // 左上以外の内容は破棄(Excelと同じく警告なしで捨てる簡易版)
  for (const key of keysInRect(doc, rect)) {
    if (key !== anchorKey) delete cells[key];
  }
  const newMerge: MergeRect = {
    r0: doc.rows[rect.r0].id,
    c0: doc.cols[rect.c0].id,
    r1: doc.rows[rect.r1].id,
    c1: doc.cols[rect.c1].id,
  };
  const merges = [...doc.merges.filter((m) => !absorbed.has(m)), newMerge];
  const next = commitDoc(state, { ...doc, cells, merges });
  const anchor: CellAddr = { row: newMerge.r0, col: newMerge.c0 };
  return { ...next, selection: { anchor, focus: anchor } };
}

function doMoveSelection(
  state: GridState,
  dRow: number,
  dCol: number,
  extend: boolean,
): GridState {
  const doc = state.doc;
  if (!Number.isInteger(dRow) || !Number.isInteger(dCol)) return state;
  const base = state.selection
    ? extend
      ? state.selection.focus
      : state.selection.anchor
    : { row: doc.rows[0].id, col: doc.cols[0].id };
  const start = normalizeAddr(doc, base);
  if (!start) return state;

  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  let ri = clamp(rowIndex(doc, start.row) + dRow, doc.rows.length - 1);
  let ci = clamp(colIndex(doc, start.col) + dCol, doc.cols.length - 1);
  let target = normalizeAddr(doc, { row: doc.rows[ri].id, col: doc.cols[ci].id })!;

  // 移動先が同じ結合に吸い込まれて動けない場合、結合を抜けるまで進む
  const stepR = Math.sign(dRow);
  const stepC = Math.sign(dCol);
  let guard = doc.rows.length + doc.cols.length;
  while ((dRow !== 0 || dCol !== 0) && sameAddr(target, start) && guard-- > 0) {
    const nri = clamp(ri + stepR, doc.rows.length - 1);
    const nci = clamp(ci + stepC, doc.cols.length - 1);
    if (nri === ri && nci === ci) break; // 端に到達
    ri = nri;
    ci = nci;
    target = normalizeAddr(doc, { row: doc.rows[ri].id, col: doc.cols[ci].id })!;
  }

  const anchor = extend && state.selection ? state.selection.anchor : target;
  return { ...state, selection: { anchor, focus: target } };
}

// ---- reducer 本体 ----

export function reduce(state: GridState, action: Action): GridState {
  const doc = state.doc;
  switch (action.type) {
    case "setCell": {
      const addr = normalizeAddr(doc, action.addr);
      if (!addr || typeof action.raw !== "string") return state;
      return commitDoc(state, setCellContent(doc, addr, action.raw));
    }

    case "clearRange": {
      const base = rectFromAddrs(doc, action.anchor, action.focus);
      if (!base) return state;
      // ビューが選択として見せる範囲(結合を含むまで拡張)と同じ範囲を消す
      const { rect } = expandRectOverMerges(doc, base);
      const keys = keysInRect(doc, rect).filter((k) => k in doc.cells);
      if (keys.length === 0) return state;
      const cells = { ...doc.cells };
      for (const k of keys) delete cells[k];
      return commitDoc(state, { ...doc, cells });
    }

    case "setSelection": {
      const s = commitPendingEdit(state);
      const anchor = normalizeAddr(s.doc, action.anchor);
      const focus = normalizeAddr(s.doc, action.focus);
      if (!anchor || !focus) return s;
      if (
        s.selection &&
        sameAddr(s.selection.anchor, anchor) &&
        sameAddr(s.selection.focus, focus)
      ) {
        return s; // 選択が実質同じなら再レンダを起こさない
      }
      return { ...s, selection: { anchor, focus } };
    }

    case "clearSelection":
      return state.selection === null ? state : { ...state, selection: null };

    case "moveSelection":
      return doMoveSelection(commitPendingEdit(state), action.dRow, action.dCol, action.extend);

    case "startEdit": {
      const where = action.where ?? "cell";
      // 編集中に別のUI(セル↔数式バー)へ入力が移る場合は、下書きを保ったまま
      // 受け口だけ差し替える
      if (state.editing) {
        return state.editing.where === where
          ? state
          : { ...state, editing: { ...state.editing, where } };
      }
      if (!state.selection) return state;
      const addr = normalizeAddr(doc, state.selection.anchor);
      if (!addr) return state;
      const draft = action.draft ?? cellRawString(doc, addr);
      return { ...state, editing: { addr, draft, where } };
    }

    case "setDraft": {
      if (typeof action.draft !== "string") return state;
      if (state.editing) {
        return state.editing.draft === action.draft
          ? state
          : { ...state, editing: { ...state.editing, draft: action.draft } };
      }
      if (!state.selection) return state;
      const addr = normalizeAddr(doc, state.selection.anchor);
      if (!addr) return state;
      return { ...state, editing: { addr, draft: action.draft, where: "cell" } };
    }

    case "commitEdit":
      return commitPendingEdit(state);

    case "cancelEdit":
      return state.editing === null ? state : { ...state, editing: null };

    case "insertRow":
      return doInsertLines(state, rowOps, action.index, action.count);
    case "insertCol":
      return doInsertLines(state, colOps, action.index, action.count);
    case "deleteRows":
      return doDeleteLines(state, rowOps, action.ids);
    case "deleteCols":
      return doDeleteLines(state, colOps, action.ids);
    case "resizeRow":
      return doResizeLine(state, "row", action.id, action.height);
    case "resizeCol":
      return doResizeLine(state, "col", action.id, action.width);

    case "merge":
      return doMerge(state, action.anchor, action.focus);

    case "unmerge": {
      if (!addrExists(doc, action.addr)) return state;
      const m = mergeAt(doc, action.addr);
      if (!m) return state;
      return commitDoc(state, { ...doc, merges: doc.merges.filter((x) => x !== m) });
    }

    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        ...state,
        doc: prev,
        ...fixupUi(state.doc, prev, state),
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...state,
        doc: next,
        ...fixupUi(state.doc, next, state),
        past: [...state.past, state.doc],
        future: state.future.slice(1),
      };
    }
  }
}
