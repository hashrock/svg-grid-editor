// 数式評価器。モデルから派生する読み取り専用の計算で、reducer とは独立。
// 依存関係はASTを辿って動的に解決し、DFSの訪問状態で循環参照を検出する。

import {
  type CellKey,
  type Expr,
  type GridDoc,
  cellKey,
  rectBounds,
  rowIndex,
  colIndex,
} from "../model/types";

export type CellValue =
  | { kind: "empty" }
  | { kind: "number"; value: number }
  | { kind: "text"; text: string }
  | { kind: "error"; code: "#REF!" | "#CYCLE!" | "#VALUE!" | "#DIV/0!" };

const EMPTY: CellValue = { kind: "empty" };

/** 全セルの評価結果。表示とテストの両方から使う */
export function evaluateDoc(doc: GridDoc): Map<CellKey, CellValue> {
  const memo = new Map<CellKey, CellValue>();
  const visiting = new Set<CellKey>();

  function valueOfKey(key: CellKey): CellValue {
    const cached = memo.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { kind: "error", code: "#CYCLE!" };

    const content = doc.cells[key];
    let result: CellValue;
    if (!content) {
      result = EMPTY;
    } else if (content.kind === "text") {
      const n = Number(content.text);
      result =
        content.text.trim() !== "" && Number.isFinite(n)
          ? { kind: "number", value: n }
          : { kind: "text", text: content.text };
    } else {
      visiting.add(key);
      result = evalExpr(content.ast);
      visiting.delete(key);
    }
    memo.set(key, result);
    return result;
  }

  function asNumber(v: CellValue): number | CellValue {
    switch (v.kind) {
      case "empty":
        return 0;
      case "number":
        return v.value;
      case "text":
        return { kind: "error", code: "#VALUE!" } as CellValue;
      case "error":
        return v;
    }
  }

  function evalExpr(e: Expr): CellValue {
    switch (e.type) {
      case "num":
        return { kind: "number", value: e.value };
      case "refError":
        return { kind: "error", code: "#REF!" };
      case "ref": {
        if (rowIndex(doc, e.row) < 0 || colIndex(doc, e.col) < 0) {
          return { kind: "error", code: "#REF!" };
        }
        return valueOfKey(cellKey({ row: e.row, col: e.col }));
      }
      case "neg": {
        const v = asNumber(evalExpr(e.expr));
        return typeof v === "number" ? { kind: "number", value: -v } : v;
      }
      case "bin": {
        const l = asNumber(evalExpr(e.left));
        if (typeof l !== "number") return l;
        const r = asNumber(evalExpr(e.right));
        if (typeof r !== "number") return r;
        if (e.op === "/" && r === 0) return { kind: "error", code: "#DIV/0!" };
        const value =
          e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : l / r;
        return { kind: "number", value };
      }
      case "sum": {
        const b = rectBounds(doc, e.range);
        if (!b) return { kind: "error", code: "#REF!" };
        // レンジは B3:A1 のように逆順もありうるので正規化してから走査する
        const r0 = Math.min(b.r0, b.r1);
        const r1 = Math.max(b.r0, b.r1);
        const c0 = Math.min(b.c0, b.c1);
        const c1 = Math.max(b.c0, b.c1);
        let total = 0;
        for (let ri = r0; ri <= r1; ri++) {
          for (let ci = c0; ci <= c1; ci++) {
            const v = valueOfKey(cellKey({ row: doc.rows[ri].id, col: doc.cols[ci].id }));
            if (v.kind === "error") return v;
            if (v.kind === "number") total += v.value;
            // SUM はテキストと空セルを無視する(Excel準拠)
          }
        }
        return { kind: "number", value: total };
      }
    }
  }

  for (const key of Object.keys(doc.cells)) valueOfKey(key);
  return memo;
}

export function displayValue(v: CellValue | undefined): string {
  if (!v || v.kind === "empty") return "";
  switch (v.kind) {
    case "number": {
      // 浮動小数点誤差の見た目を軽減
      const rounded = Math.round(v.value * 1e10) / 1e10;
      return String(rounded);
    }
    case "text":
      return v.text;
    case "error":
      return v.code;
  }
}
