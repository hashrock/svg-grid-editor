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
  const containerRef = useRef<HTMLDivElement>(null);

  // 編集が終わったら(textarea がアンマウントされたら)キーボード操作を
  // 受けるコンテナへフォーカスを戻す。編集終了の全経路に共通で効く
  useEffect(() => {
    if (!editing) containerRef.current?.focus();
  }, [editing]);

  const anchorRi = selection ? rowIndex(doc, selection.anchor.row) : -1;
  const anchorCi = selection ? colIndex(doc, selection.anchor.col) : -1;
  const anchorRaw = selection ? cellRawString(doc, selection.anchor) : "";

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing) return; // 編集中は textarea 側が処理する

    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      dispatch({ type: "redo" });
      e.preventDefault();
      return;
    }

    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (e.key in arrows) {
      const [dRow, dCol] = arrows[e.key];
      dispatch({ type: "moveSelection", dRow, dCol, extend: e.shiftKey });
      e.preventDefault();
      return;
    }

    if (e.key === "Enter" || e.key === "F2") {
      dispatch({ type: "startEdit" });
      e.preventDefault();
      return;
    }
    if (e.key === "Tab") {
      dispatch({ type: "moveSelection", dRow: 0, dCol: e.shiftKey ? -1 : 1, extend: false });
      e.preventDefault();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      dispatch({ type: "clearRange", anchor: selection.anchor, focus: selection.focus });
      e.preventDefault();
      return;
    }
    // 印字可能文字で編集開始(内容を置き換える)
    if (e.key.length === 1 && !mod) {
      dispatch({ type: "startEdit", draft: e.key });
      e.preventDefault();
    }
  }

  return (
    <div className="app" ref={containerRef} tabIndex={0} onKeyDown={onKeyDown}>
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
        <span className="raw">{editing ? editing.draft : anchorRaw}</span>
      </div>

      <GridView state={state} dispatch={dispatch} />

      <div className="hint">
        ダブルクリック / Enter / F2 で編集、=A1+B2 や =SUM(A1:B3) で数式、
        ヘッダ境界ドラッグでリサイズ、Shift+矢印で範囲選択
      </div>
    </div>
  );
}
