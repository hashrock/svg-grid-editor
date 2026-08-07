// 数式パーサ。"=A1+SUM(B2:B5)*2" のような入力を、A1形式の参照を
// 現在のグリッド位置で解決した「IDベースのAST」に変換する。
// 以降、行列が挿入・削除されてもASTは書き換え不要で参照が追従する。

import type { Expr, GridDoc } from "../model/types";

// ---- A1形式 <-> インデックス ----

export function colLabel(index: number): string {
  let label = "";
  let n = index;
  for (;;) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return label;
}

export function colLabelToIndex(label: string): number {
  let n = 0;
  for (const ch of label) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function addrLabel(rowIdx: number, colIdx: number): string {
  return `${colLabel(colIdx)}${rowIdx + 1}`;
}

// ---- トークナイザ ----

type Token =
  | { t: "num"; value: number }
  | { t: "cellref"; col: string; row: number }
  | { t: "ident"; name: string }
  | { t: "op"; op: string }; // + - * / ( ) : ,

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
    } else if ("+-*/():,".includes(ch)) {
      tokens.push({ t: "op", op: ch });
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) return null;
      tokens.push({ t: "num", value: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z]+[0-9]*/.exec(src.slice(i))!;
      const word = m[0].toUpperCase();
      const cellMatch = /^([A-Z]+)([0-9]+)$/.exec(word);
      if (cellMatch) {
        tokens.push({ t: "cellref", col: cellMatch[1], row: Number(cellMatch[2]) - 1 });
      } else if (/^[A-Z]+$/.test(word)) {
        tokens.push({ t: "ident", name: word });
      } else {
        return null;
      }
      i += m[0].length;
    } else {
      return null;
    }
  }
  return tokens;
}

// ---- パーサ(再帰下降) ----

class Parser {
  pos = 0;
  tokens: Token[];
  doc: GridDoc;

  constructor(tokens: Token[], doc: GridDoc) {
    this.tokens = tokens;
    this.doc = doc;
  }

  peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  eatOp(op: string): boolean {
    const t = this.peek();
    if (t && t.t === "op" && t.op === op) {
      this.pos++;
      return true;
    }
    return false;
  }

  resolveRef(col: string, row: number): Expr {
    const ci = colLabelToIndex(col);
    if (row < 0 || row >= this.doc.rows.length || ci < 0 || ci >= this.doc.cols.length) {
      return { type: "refError" };
    }
    return { type: "ref", row: this.doc.rows[row].id, col: this.doc.cols[ci].id };
  }

  /** 左結合の二項演算レベル: ops のいずれかが続く限り next を畳み込む */
  parseBinLevel(ops: ("+" | "-" | "*" | "/")[], next: () => Expr | null): Expr | null {
    let left = next();
    if (!left) return null;
    for (;;) {
      const op = ops.find((o) => this.eatOp(o));
      if (!op) return left;
      const right = next();
      if (!right) return null;
      left = { type: "bin", op, left, right };
    }
  }

  parseExpr(): Expr | null {
    return this.parseBinLevel(["+", "-"], () => this.parseTerm());
  }

  parseTerm(): Expr | null {
    return this.parseBinLevel(["*", "/"], () => this.parseUnary());
  }

  parseUnary(): Expr | null {
    if (this.eatOp("-")) {
      const e = this.parseUnary();
      return e ? { type: "neg", expr: e } : null;
    }
    return this.parseAtom();
  }

  parseAtom(): Expr | null {
    const t = this.peek();
    if (!t) return null;
    if (t.t === "num") {
      this.pos++;
      return { type: "num", value: t.value };
    }
    if (t.t === "cellref") {
      this.pos++;
      return this.resolveRef(t.col, t.row);
    }
    if (t.t === "ident" && t.name === "SUM") {
      this.pos++;
      if (!this.eatOp("(")) return null;
      const a = this.peek();
      if (!a || a.t !== "cellref") return null;
      this.pos++;
      if (!this.eatOp(":")) return null;
      const b = this.peek();
      if (!b || b.t !== "cellref") return null;
      this.pos++;
      if (!this.eatOp(")")) return null;
      const ra = this.resolveRef(a.col, a.row);
      const rb = this.resolveRef(b.col, b.row);
      if (ra.type !== "ref" || rb.type !== "ref") return { type: "refError" };
      return { type: "sum", range: { r0: ra.row, c0: ra.col, r1: rb.row, c1: rb.col } };
    }
    if (t.t === "op" && t.op === "(") {
      this.pos++;
      const e = this.parseExpr();
      if (!e || !this.eatOp(")")) return null;
      return e;
    }
    return null;
  }
}

/** "=..." の "=" より後ろをパースする。失敗時は null(呼び出し側でテキスト扱い) */
export function parseFormula(doc: GridDoc, src: string): Expr | null {
  const tokens = tokenize(src);
  if (!tokens) return null;
  const p = new Parser(tokens, doc);
  const expr = p.parseExpr();
  if (!expr || p.pos !== tokens.length) return null;
  return expr;
}

// ---- AST -> 表示用文字列(現在の位置でA1形式に逆変換) ----

import { rowIndex, colIndex, rectBounds } from "../model/types";

export function formatExpr(doc: GridDoc, e: Expr): string {
  switch (e.type) {
    case "num":
      return String(e.value);
    case "refError":
      return "#REF!";
    case "ref": {
      const ri = rowIndex(doc, e.row);
      const ci = colIndex(doc, e.col);
      return ri < 0 || ci < 0 ? "#REF!" : addrLabel(ri, ci);
    }
    case "neg":
      return `-${formatExpr(doc, e.expr)}`;
    case "bin": {
      const wrap = (child: Expr, side: "l" | "r"): string => {
        const s = formatExpr(doc, child);
        if (child.type !== "bin") return s;
        const prec = (op: string) => (op === "+" || op === "-" ? 1 : 2);
        const needParen =
          prec(child.op) < prec(e.op) ||
          (prec(child.op) === prec(e.op) && side === "r" && (e.op === "-" || e.op === "/"));
        return needParen ? `(${s})` : s;
      };
      return `${wrap(e.left, "l")}${e.op}${wrap(e.right, "r")}`;
    }
    case "sum": {
      const b = rectBounds(doc, e.range);
      if (!b) return "SUM(#REF!)";
      return `SUM(${addrLabel(b.r0, b.c0)}:${addrLabel(b.r1, b.c1)})`;
    }
  }
}
