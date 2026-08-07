// Property-based test — TLA+ の代替として、実装そのものをモデル検査する。
// ランダムな(しばしば不正な)アクション列を reducer に流し、
//   P1: すべての不変条件が全ステップで保たれる
//   P2: reducer は引数をミューテートしない(deep-freeze で検出)
//   P3: undo で過去の doc が正確に復元され、redo で完全に戻る
//   P4: 数式評価は決定的で、どんな doc でも例外を投げない
// ことを検証する。ジェネレータは意図的に存在しないIDや範囲外の値も投げる。

import { describe, it } from "vitest";
import fc from "fast-check";
import type { Action } from "./actions";
import { createInitialState, reduce } from "./reducer";
import { checkInvariants } from "./invariants";
import type { GridState } from "./types";
import { evaluateDoc } from "../formula/eval";

// ---- ジェネレータ ----

// 初期グリッドは 6x5 (id: r0..r5, c6..c10)。挿入で増えるIDも含めて
// 有効・無効が混ざる範囲から引く。
const arbRowId = fc.integer({ min: 0, max: 30 }).map((n) => `r${n}`);
const arbColId = fc.integer({ min: 0, max: 30 }).map((n) => `c${n}`);
const arbAddr = fc.record({ row: arbRowId, col: arbColId });
const arbIndex = fc.integer({ min: -2, max: 12 });
const arbDelta = fc.integer({ min: -3, max: 3 });
const arbSize = fc.integer({ min: -10, max: 300 });

const arbRaw = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("", "hello", "42", "-1.5", "テキスト") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "=A1",
      "=A1+B2*2",
      "=SUM(A1:B3)",
      "=1/0",
      "=A1+",
      "=Z99",
      "=SUM(A1:Z99)",
      "=-(A2-B1)/2",
    ),
  },
);

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ type: fc.constant("setCell" as const), addr: arbAddr, raw: arbRaw }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("clearRange" as const), anchor: arbAddr, focus: arbAddr }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("setSelection" as const), anchor: arbAddr, focus: arbAddr }) },
  { weight: 1, arbitrary: fc.constant({ type: "clearSelection" } as Action) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("moveSelection" as const), dRow: arbDelta, dCol: arbDelta, extend: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("startEdit" as const), draft: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }), where: fc.option(fc.constantFrom("cell" as const, "bar" as const), { nil: undefined }) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("setDraft" as const), draft: fc.string({ maxLength: 8 }) }) },
  { weight: 2, arbitrary: fc.constant({ type: "commitEdit" } as Action) },
  { weight: 1, arbitrary: fc.constant({ type: "cancelEdit" } as Action) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("insertRow" as const), index: arbIndex, count: fc.option(fc.integer({ min: -1, max: 4 }), { nil: undefined }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("insertCol" as const), index: arbIndex, count: fc.option(fc.integer({ min: -1, max: 4 }), { nil: undefined }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("deleteRows" as const), ids: fc.array(arbRowId, { maxLength: 8 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("deleteCols" as const), ids: fc.array(arbColId, { maxLength: 8 }) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("resizeRow" as const), id: arbRowId, height: arbSize }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("resizeCol" as const), id: arbColId, width: arbSize }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("merge" as const), anchor: arbAddr, focus: arbAddr }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("unmerge" as const), addr: arbAddr }) },
  { weight: 2, arbitrary: fc.constant({ type: "undo" } as Action) },
  { weight: 2, arbitrary: fc.constant({ type: "redo" } as Action) },
);

const arbActions = fc.array(arbAction, { maxLength: 60 });

// ---- ヘルパ ----

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

function initialState(): GridState {
  // 初期IDが r0..r5 / c6..c10 になり、ジェネレータの範囲と噛み合う
  return createInitialState(6, 5);
}

// ---- プロパティ ----

describe("property: reducer", () => {
  it("P1+P2: 任意のアクション列で不変条件が保たれ、状態はミューテートされない", () => {
    fc.assert(
      fc.property(arbActions, (actions) => {
        let state = deepFreeze(initialState());
        for (const action of actions) {
          state = deepFreeze(reduce(state, deepFreeze(action)));
          const errors = checkInvariants(state);
          if (errors.length > 0) {
            throw new Error(
              `invariant violated after ${JSON.stringify(action)}:\n${errors.join("\n")}`,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("P3: 全undoで履歴が正確に巻き戻り、全redoで完全に復元される", () => {
    fc.assert(
      fc.property(arbActions, (actions) => {
        // undo/redo 自体は列から除き、履歴の積み上げだけを行う
        let state = initialState();
        for (const action of actions) {
          if (action.type === "undo" || action.type === "redo") continue;
          state = reduce(state, action);
        }
        const finalDoc = state.doc;
        const snapshots = [...state.past, finalDoc];

        // 全部 undo: 各ステップで past の末尾スナップショットと参照一致するはず
        let s = state;
        for (let i = snapshots.length - 2; i >= 0; i--) {
          s = reduce(s, { type: "undo" });
          if (s.doc !== snapshots[i]) throw new Error(`undo mismatch at ${i}`);
          if (checkInvariants(s).length > 0) throw new Error("invariant broken by undo");
        }
        if (s.past.length !== 0) throw new Error("past not exhausted");

        // 全部 redo: 最終 doc に参照一致で戻るはず
        for (let i = 1; i < snapshots.length; i++) {
          s = reduce(s, { type: "redo" });
          if (s.doc !== snapshots[i]) throw new Error(`redo mismatch at ${i}`);
        }
        if (s.doc !== finalDoc) throw new Error("redo did not restore final doc");
      }),
      { numRuns: 200 },
    );
  });

  it("P4: 数式評価は例外を投げず、同一docに対して決定的", () => {
    fc.assert(
      fc.property(arbActions, (actions) => {
        let state = initialState();
        for (const action of actions) state = reduce(state, action);
        const a = evaluateDoc(state.doc);
        const b = evaluateDoc(state.doc);
        if (JSON.stringify([...a]) !== JSON.stringify([...b])) {
          throw new Error("evaluation is not deterministic");
        }
      }),
      { numRuns: 200 },
    );
  });
});
