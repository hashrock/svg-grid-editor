import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { createInitialState, reduce } from "./reducer";
import { checkInvariants } from "./invariants";
import { type GridState, cellKey } from "./types";
import { evaluateDoc, displayValue } from "../formula/eval";
import { formatExpr } from "../formula/parse";

function run(state: GridState, ...actions: Action[]): GridState {
  return actions.reduce(reduce, state);
}

function addr(state: GridState, ri: number, ci: number) {
  return { row: state.doc.rows[ri].id, col: state.doc.cols[ci].id };
}

function valueAt(state: GridState, ri: number, ci: number): string {
  const values = evaluateDoc(state.doc);
  return displayValue(values.get(cellKey(addr(state, ri, ci))));
}

describe("セル編集", () => {
  it("テキストと数値を設定・クリアできる", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "hello" },
      { type: "setCell", addr: addr(s, 1, 0), raw: "42" },
    );
    expect(valueAt(s, 0, 0)).toBe("hello");
    expect(valueAt(s, 1, 0)).toBe("42");
    s = run(s, { type: "setCell", addr: addr(s, 0, 0), raw: "" });
    expect(valueAt(s, 0, 0)).toBe("");
    expect(checkInvariants(s)).toEqual([]);
  });

  it("編集モードの開始・更新・確定", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setSelection", anchor: addr(s, 2, 2), focus: addr(s, 2, 2) },
      { type: "startEdit", draft: "x" },
      { type: "setDraft", draft: "xyz" },
      { type: "commitEdit" },
    );
    expect(valueAt(s, 2, 2)).toBe("xyz");
    expect(s.editing).toBeNull();
  });

  it("cancelEdit は内容を反映しない", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "startEdit", draft: "tmp" },
      { type: "cancelEdit" },
    );
    expect(valueAt(s, 0, 0)).toBe("");
  });

  it("編集の受け口(セル/数式バー)を下書きを保ったまま切り替えられる", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "startEdit", draft: "abc" });
    expect(s.editing?.where).toBe("cell");
    s = run(s, { type: "startEdit", where: "bar" });
    expect(s.editing).toEqual({ addr: addr(s, 0, 0), draft: "abc", where: "bar" });
    s = run(s, { type: "startEdit", where: "cell" });
    expect(s.editing?.where).toBe("cell");
    expect(s.editing?.draft).toBe("abc"); // 切り替えで下書きは失われない
  });

  it("数式バーから編集を開始すると既存内容が下書きになる", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "=1+2" },
      { type: "startEdit", where: "bar" },
    );
    expect(s.editing).toEqual({ addr: addr(s, 0, 0), draft: "=1+2", where: "bar" });
  });

  it("選択が移動すると編集中の内容は破棄されず確定される", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "startEdit", draft: "書きかけ" },
      { type: "moveSelection", dRow: 1, dCol: 0, extend: false },
    );
    expect(valueAt(s, 0, 0)).toBe("書きかけ");
    expect(s.editing).toBeNull();
    expect(s.selection?.anchor).toEqual(addr(s, 1, 0));
  });
});

describe("数式", () => {
  it("四則演算と参照を評価する", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "10" },
      { type: "setCell", addr: addr(s, 1, 0), raw: "4" },
      { type: "setCell", addr: addr(s, 0, 1), raw: "=A1+A2*2" },
      { type: "setCell", addr: addr(s, 1, 1), raw: "=(A1-A2)/2" },
    );
    expect(valueAt(s, 0, 1)).toBe("18");
    expect(valueAt(s, 1, 1)).toBe("3");
  });

  it("SUM と空セル・テキストの扱い", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "1" },
      { type: "setCell", addr: addr(s, 1, 0), raw: "2" },
      { type: "setCell", addr: addr(s, 2, 0), raw: "note" }, // SUMはテキストを無視
      { type: "setCell", addr: addr(s, 0, 1), raw: "=SUM(A1:A4)" },
    );
    expect(valueAt(s, 0, 1)).toBe("3");
  });

  it("循環参照は #CYCLE! になる", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "=B1" },
      { type: "setCell", addr: addr(s, 0, 1), raw: "=A1" },
    );
    expect(valueAt(s, 0, 0)).toBe("#CYCLE!");
    expect(valueAt(s, 0, 1)).toBe("#CYCLE!");
  });

  it("自己参照も #CYCLE!", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "setCell", addr: addr(s, 0, 0), raw: "=A1+1" });
    expect(valueAt(s, 0, 0)).toBe("#CYCLE!");
  });

  it("ゼロ除算は #DIV/0!、テキスト演算は #VALUE!", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "abc" },
      { type: "setCell", addr: addr(s, 0, 1), raw: "=1/0" },
      { type: "setCell", addr: addr(s, 1, 1), raw: "=A1+1" },
    );
    expect(valueAt(s, 0, 1)).toBe("#DIV/0!");
    expect(valueAt(s, 1, 1)).toBe("#VALUE!");
  });

  it("パース失敗はテキストとして保存される", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "setCell", addr: addr(s, 0, 0), raw: "=1++" });
    expect(valueAt(s, 0, 0)).toBe("=1++");
  });
});

describe("行列操作と参照の追従(安定IDの本領)", () => {
  it("行挿入で参照が自動追従する", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 2, 0), raw: "7" }, // A3
      { type: "setCell", addr: addr(s, 0, 1), raw: "=A3" }, // B1
    );
    // 先頭に行を挿入 → 7 は A4 に移動するが、参照はIDなので追従する
    s = run(s, { type: "insertRow", index: 0 });
    expect(valueAt(s, 1, 1)).toBe("7"); // 元B1はB2に移動、値は変わらず
    // 表示用の数式文字列も新しい位置で再生成される
    const cell = s.doc.cells[cellKey(addr(s, 1, 1))];
    expect(cell.kind === "formula" && formatExpr(s.doc, cell.ast)).toBe("A4");
  });

  it("参照先の行を削除すると #REF! になる", () => {
    let s = createInitialState(5, 5);
    const rowToDelete = s.doc.rows[2].id;
    s = run(
      s,
      { type: "setCell", addr: addr(s, 2, 0), raw: "7" },
      { type: "setCell", addr: addr(s, 0, 1), raw: "=A3" },
      { type: "deleteRow", id: rowToDelete },
    );
    expect(valueAt(s, 0, 1)).toBe("#REF!");
  });

  it("最後の1行・1列は削除できない", () => {
    let s = createInitialState(1, 1);
    const before = s.doc;
    s = run(
      s,
      { type: "deleteRow", id: s.doc.rows[0].id },
      { type: "deleteCol", id: s.doc.cols[0].id },
    );
    expect(s.doc).toBe(before);
  });

  it("リサイズは最小値でクランプされる", () => {
    let s = createInitialState(3, 3);
    s = run(
      s,
      { type: "resizeRow", id: s.doc.rows[0].id, height: 1 },
      { type: "resizeCol", id: s.doc.cols[0].id, width: -50 },
    );
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe("セル結合", () => {
  it("結合すると左上以外の内容が消え、選択はアンカーに移る", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "keep" },
      { type: "setCell", addr: addr(s, 1, 1), raw: "lose" },
      { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 1, 1) },
    );
    expect(s.doc.merges).toHaveLength(1);
    expect(valueAt(s, 0, 0)).toBe("keep");
    expect(s.doc.cells[cellKey(addr(s, 1, 1))]).toBeUndefined();
    expect(s.selection?.anchor).toEqual(addr(s, 0, 0));
    expect(checkInvariants(s)).toEqual([]);
  });

  it("交差する結合は吸収して1つに拡張される", () => {
    let s = createInitialState(6, 6);
    s = run(
      s,
      { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 1, 1) },
      { type: "merge", anchor: addr(s, 1, 1), focus: addr(s, 2, 2) },
    );
    expect(s.doc.merges).toHaveLength(1);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("結合範囲内への行挿入は結合を押し広げる", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 2, 1) });
    s = run(s, { type: "insertRow", index: 1 });
    const b = s.doc.merges[0];
    expect(s.doc.rows.findIndex((r) => r.id === b.r1)).toBe(3); // 2→3 に拡大
    expect(checkInvariants(s)).toEqual([]);
  });

  it("結合のアンカー行を削除すると次の行がアンカーになる", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 2, 1) });
    s = run(s, { type: "deleteRow", id: s.doc.rows[0].id });
    expect(s.doc.merges).toHaveLength(1);
    expect(s.doc.merges[0].r0).toBe(s.doc.rows[0].id);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("縦2セル結合の1行を消すと結合自体が消える", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 1, 0) });
    s = run(s, { type: "deleteRow", id: s.doc.rows[0].id });
    expect(s.doc.merges).toHaveLength(0);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("unmerge で解除できる(被覆セルを指しても可)", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 1, 1) });
    s = run(s, { type: "unmerge", addr: addr(s, 1, 1) });
    expect(s.doc.merges).toHaveLength(0);
  });

  it("被覆セルへの setCell はアンカーに書き込まれる", () => {
    let s = createInitialState(5, 5);
    s = run(s, { type: "merge", anchor: addr(s, 0, 0), focus: addr(s, 1, 1) });
    s = run(s, { type: "setCell", addr: addr(s, 1, 1), raw: "hi" });
    expect(valueAt(s, 0, 0)).toBe("hi");
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe("選択と移動", () => {
  it("結合セルを跨いで移動できる", () => {
    let s = createInitialState(5, 5);
    s = run(
      s,
      { type: "merge", anchor: addr(s, 0, 1), focus: addr(s, 0, 2) }, // B1:C1
      { type: "setSelection", anchor: addr(s, 0, 0), focus: addr(s, 0, 0) },
      { type: "moveSelection", dRow: 0, dCol: 1, extend: false }, // → 結合アンカー
    );
    expect(s.selection?.anchor).toEqual(addr(s, 0, 1));
    s = run(s, { type: "moveSelection", dRow: 0, dCol: 1, extend: false }); // 結合を抜ける
    expect(s.selection?.anchor).toEqual(addr(s, 0, 3));
  });

  it("端でクランプされる", () => {
    let s = createInitialState(3, 3);
    s = run(s, { type: "moveSelection", dRow: -5, dCol: -5, extend: false });
    expect(s.selection?.anchor).toEqual(addr(s, 0, 0));
  });
});

describe("undo/redo", () => {
  it("doc の変更のみが履歴に積まれる", () => {
    let s = createInitialState(3, 3);
    s = run(
      s,
      { type: "setSelection", anchor: addr(s, 1, 1), focus: addr(s, 1, 1) }, // 履歴外
      { type: "setCell", addr: addr(s, 0, 0), raw: "a" },
      { type: "moveSelection", dRow: 1, dCol: 0, extend: false }, // 履歴外
    );
    expect(s.past).toHaveLength(1);
  });

  it("undo→redo で元に戻る", () => {
    let s = createInitialState(3, 3);
    s = run(s, { type: "setCell", addr: addr(s, 0, 0), raw: "a" });
    const after = s.doc;
    s = run(s, { type: "undo" });
    expect(valueAt(s, 0, 0)).toBe("");
    s = run(s, { type: "redo" });
    expect(s.doc).toBe(after);
  });

  it("undo で行が消えても選択は生き残る位置に正規化される", () => {
    let s = createInitialState(3, 3);
    s = run(s, { type: "insertRow", index: 3 });
    s = run(s, {
      type: "setSelection",
      anchor: addr(s, 3, 0),
      focus: addr(s, 3, 0),
    });
    s = run(s, { type: "undo" }); // 挿入した行が消える → 選択先が消滅
    expect(checkInvariants(s)).toEqual([]);
  });

  it("新しい変更で redo 履歴が消える", () => {
    let s = createInitialState(3, 3);
    s = run(
      s,
      { type: "setCell", addr: addr(s, 0, 0), raw: "a" },
      { type: "undo" },
      { type: "setCell", addr: addr(s, 0, 0), raw: "b" },
    );
    expect(s.future).toHaveLength(0);
  });
});
