import { useEffect, useReducer, useRef } from "react";
import { createInitialState, reduce } from "./model/reducer";
import { colIndex, rowIndex } from "./model/types";
import { cellRawString } from "./model/derive";
import { addrLabel } from "./formula/parse";
import { GridView } from "./view/GridView";
import "./App.css";

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, () => createInitialState());
  const { doc, selection, editing } = state;
  const barRef = useRef<HTMLInputElement>(null);

  // キーボード操作は GridView 内の常設エディタが一括で受ける。
  // ここは数式バーが編集を受け持っている間のフォーカスだけを面倒見る
  useEffect(() => {
    if (editing?.where === "bar") barRef.current?.focus();
  }, [editing?.where]);

  const anchorRi = selection ? rowIndex(doc, selection.anchor.row) : -1;
  const anchorCi = selection ? colIndex(doc, selection.anchor.col) : -1;
  const anchorRaw = selection ? cellRawString(doc, selection.anchor) : "";

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0}>
          ⌘Z 元に戻す
        </button>
        <button onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0}>
          やり直す
        </button>
        <span className="sep" />
        <button
          disabled={anchorRi < 0}
          onClick={() => dispatch({ type: "insertRow", index: anchorRi })}
        >
          ↑行挿入
        </button>
        <button
          disabled={anchorRi < 0}
          onClick={() => dispatch({ type: "insertRow", index: anchorRi + 1 })}
        >
          ↓行挿入
        </button>
        <button
          disabled={!selection || doc.rows.length <= 1}
          onClick={() => selection && dispatch({ type: "deleteRow", id: selection.anchor.row })}
        >
          行削除
        </button>
        <span className="sep" />
        <button
          disabled={anchorCi < 0}
          onClick={() => dispatch({ type: "insertCol", index: anchorCi })}
        >
          ←列挿入
        </button>
        <button
          disabled={anchorCi < 0}
          onClick={() => dispatch({ type: "insertCol", index: anchorCi + 1 })}
        >
          →列挿入
        </button>
        <button
          disabled={!selection || doc.cols.length <= 1}
          onClick={() => selection && dispatch({ type: "deleteCol", id: selection.anchor.col })}
        >
          列削除
        </button>
        <span className="sep" />
        <button
          disabled={!selection}
          onClick={() =>
            selection &&
            dispatch({ type: "merge", anchor: selection.anchor, focus: selection.focus })
          }
        >
          結合
        </button>
        <button
          disabled={!selection}
          onClick={() => selection && dispatch({ type: "unmerge", addr: selection.anchor })}
        >
          結合解除
        </button>
      </div>

      <div className="formula-bar">
        <span className="addr">
          {anchorRi >= 0 && anchorCi >= 0 ? addrLabel(anchorRi, anchorCi) : ""}
        </span>
        <input
          ref={barRef}
          className="raw"
          type="text"
          disabled={!selection}
          value={editing ? editing.draft : anchorRaw}
          onFocus={() => dispatch({ type: "startEdit", where: "bar" })}
          onChange={(e) => dispatch({ type: "setDraft", draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              dispatch({ type: "moveSelection", dRow: 1, dCol: 0, extend: false });
            } else if (e.key === "Escape") {
              e.preventDefault();
              dispatch({ type: "cancelEdit" });
            }
          }}
        />
      </div>

      <GridView state={state} dispatch={dispatch} />

      <div className="hint">
        ダブルクリック / Enter / F2 で編集、=A1+B2 や =SUM(A1:B3) で数式、
        Alt+Enter でセル内改行、ヘッダのクリックで行列選択・境界ドラッグでリサイズ、
        Shift+矢印で範囲選択
      </div>
    </div>
  );
}
