// SVGグリッド本体。state を受け取り描画するだけの薄い層で、
// すべての状態変更は dispatch(Action) 経由で行う。
// 編集の確定・破棄の規則は reducer が持つ(選択が動けば自動コミット)ため、
// ここではイベントを対応するアクションに変換するだけでよい。

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "../model/actions";
import {
  type CellAddr,
  type CellKey,
  type GridState,
  cellKey,
  parseCellKey,
  colIndex,
  rectBounds,
} from "../model/types";
import { selectionRect, type IndexRect } from "../model/derive";
import { evaluateDoc, displayValue } from "../formula/eval";
import { colLabel } from "../formula/parse";
import {
  CellText,
  measureCellHeight,
  CELL_FONT_SIZE,
  CELL_LINE_HEIGHT,
  CELL_PAD,
} from "./CellText";

const HEADER_W = 44;
const HEADER_H = 26;
// 掴み代。細すぎると熟練者でも掴み損ねるので境界の前後に余裕を持たせる
const RESIZE_GRIP = 9;

type ResizeDrag = {
  kind: "row" | "col";
  id: string;
  startPos: number;
  startSize: number;
  current: number;
};

interface Props {
  state: GridState;
  dispatch: Dispatch<Action>;
}

export function GridView({ state, dispatch }: Props) {
  const { doc, selection, editing } = state;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragAnchor = useRef<CellAddr | null>(null);
  const headerDrag = useRef<{ kind: "row" | "col"; anchor: string } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  // リサイズ中は履歴を汚さないようローカルにプレビューし、確定時のみ dispatch する
  const [resize, setResize] = useState<ResizeDrag | null>(null);

  // 結合の被覆情報を doc ごとに1回だけ解決する
  const mergeInfo = useMemo(() => {
    const covered = new Set<CellKey>(); // 非アンカー被覆セル
    const anchorSpan = new Map<CellKey, IndexRect>(); // アンカー -> 矩形
    const inMerge = new Set<CellKey>(); // 結合に属する全セル
    for (const m of doc.merges) {
      const b = rectBounds(doc, m);
      if (!b) continue;
      for (let ri = b.r0; ri <= b.r1; ri++) {
        for (let ci = b.c0; ci <= b.c1; ci++) {
          const key = cellKey({ row: doc.rows[ri].id, col: doc.cols[ci].id });
          inMerge.add(key);
          if (ri === b.r0 && ci === b.c0) anchorSpan.set(key, b);
          else covered.add(key);
        }
      }
    }
    return { covered, anchorSpan, inMerge };
  }, [doc]);

  // ジオメトリ(選択変更では再計算しない — doc とリサイズプレビューのみ依存)
  const { colWidths, rowHeights, xs, ys } = useMemo(() => {
    const colWidths = doc.cols.map((c) =>
      resize?.kind === "col" && resize.id === c.id ? resize.current : c.width,
    );

    // 行の自動高さ: 各行の必要高さ(改行・折り返し由来)をビュー側で導出し、
    // モデルの高さとの max を取る。計測結果はモデルに書き戻さない(undo対象外)
    const neededByRow = new Map<string, number>();
    for (const [key, content] of Object.entries(doc.cells)) {
      if (content.kind !== "text") continue; // 数式の評価値は1行
      if (mergeInfo.inMerge.has(key)) continue; // 結合セルは高さの分配が絡むため対象外
      const addr = parseCellKey(key);
      const ci = colIndex(doc, addr.col);
      if (ci < 0) continue;
      const needed = measureCellHeight(content.text, colWidths[ci]);
      neededByRow.set(addr.row, Math.max(neededByRow.get(addr.row) ?? 0, needed));
    }
    const rowHeights = doc.rows.map((r) => {
      const base = resize?.kind === "row" && resize.id === r.id ? resize.current : r.height;
      return Math.max(base, neededByRow.get(r.id) ?? 0);
    });

    const ys = [HEADER_H];
    for (const h of rowHeights) ys.push(ys[ys.length - 1] + h);
    const xs = [HEADER_W];
    for (const w of colWidths) xs.push(xs[xs.length - 1] + w);
    return { colWidths, rowHeights, xs, ys };
  }, [doc, resize, mergeInfo]);

  const totalW = xs[xs.length - 1];
  const totalH = ys[ys.length - 1];

  const values = useMemo(() => evaluateDoc(doc), [doc]);

  const selRect = selection ? selectionRect(doc, selection) : null;

  // ---- セル矩形の描画リスト(結合セルは1つの矩形にまとめる) ----

  const cellRects = useMemo(() => {
    const rects: { addr: CellAddr; x: number; y: number; w: number; h: number }[] = [];
    for (let ri = 0; ri < doc.rows.length; ri++) {
      for (let ci = 0; ci < doc.cols.length; ci++) {
        const addr = { row: doc.rows[ri].id, col: doc.cols[ci].id };
        const key = cellKey(addr);
        if (mergeInfo.covered.has(key)) continue;
        const span = mergeInfo.anchorSpan.get(key);
        const r1 = span ? span.r1 : ri;
        const c1 = span ? span.c1 : ci;
        rects.push({
          addr,
          x: xs[ci],
          y: ys[ri],
          w: xs[c1 + 1] - xs[ci],
          h: ys[r1 + 1] - ys[ri],
        });
      }
    }
    return rects;
  }, [doc, mergeInfo, xs, ys]);

  const editingRect = editing
    ? cellRects.find((c) => c.addr.row === editing.addr.row && c.addr.col === editing.addr.col)
    : null;
  const anchorRect = selection
    ? cellRects.find(
        (c) => c.addr.row === selection.anchor.row && c.addr.col === selection.anchor.col,
      )
    : null;

  // ---- キーボード入力の受け口 ----
  // テキストエリアは常時マウントされ、非編集時もフォーカスを保持する。
  // IME は変換確定まで keydown に文字を載せてこないため、「押されたキーを見て
  // 編集を始める」方式では日本語入力を拾えない。入力要素そのものに常に
  // フォーカスを置き、そこに文字が入ったことを合図に編集を開始する。
  const editorRect = editingRect ?? anchorRect;

  // テキストエリアは非制御にする。制御コンポーネントにすると、入力が再描画より
  // 速いときに古い value が DOM を巻き戻して文字が落ちるため。
  // 代わりに「エディタが報告した値」を pending に積み、モデルがそこに追いつく
  // 間は DOM に触れない。pending に無い値が来たら外部由来の変更として反映する。
  const pending = useRef<string[]>([]);

  function reportDraft(value: string) {
    pending.current.push(value);
    dispatch({ type: "setDraft", draft: value });
  }

  useEffect(() => {
    const el = editorRef.current;
    if (!el || composing.current) return;
    const want = editing?.draft ?? "";
    const i = pending.current.lastIndexOf(want);
    if (i >= 0) {
      pending.current.splice(0, i + 1); // モデルが追いついた分を捨てる
      return; // DOM の方が新しいので触らない
    }
    pending.current.length = 0;
    if (el.value !== want) {
      el.value = want;
      // F2・ダブルクリック・数式バー経由の編集開始はキャレットを末尾へ
      el.setSelectionRange(want.length, want.length);
    }
  }, [editing]);

  // 数式バーが編集を受けている間以外は、常にグリッド側がフォーカスを持つ
  useEffect(() => {
    if (editing?.where === "bar") return;
    const el = editorRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  });

  function onEditorInput(e: React.FormEvent<HTMLTextAreaElement>) {
    reportDraft(e.currentTarget.value);
  }

  function insertNewline(el: HTMLTextAreaElement) {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = `${el.value.slice(0, s)}\n${el.value.slice(e)}`;
    el.value = next;
    el.setSelectionRange(s + 1, s + 1);
    reportDraft(next);
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 変換中のキーはすべてIMEのもの(Enterは候補確定であって編集確定ではない)
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (editing) {
      if (e.key === "Enter" && (e.altKey || e.shiftKey)) {
        // Excel は Alt+Enter でセル内改行。Shift+Enter も同義として受ける
        if (e.altKey) {
          e.preventDefault();
          insertNewline(e.currentTarget);
        }
        return; // Shift+Enter は textarea の既定動作に任せる
      }
      if (e.key === "Enter") {
        e.preventDefault();
        dispatch({ type: "moveSelection", dRow: 1, dCol: 0, extend: false });
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        dispatch({ type: "moveSelection", dRow: 0, dCol: e.shiftKey ? -1 : 1, extend: false });
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "cancelEdit" });
      }
      return; // 編集中の矢印・Backspace等は textarea 内のカーソル操作
    }

    // ---- 非編集時 ----
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      dispatch({ type: "redo" });
      return;
    }

    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (e.key in arrows) {
      e.preventDefault();
      const [dRow, dCol] = arrows[e.key];
      dispatch({ type: "moveSelection", dRow, dCol, extend: e.shiftKey });
      return;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      dispatch({ type: "startEdit" });
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      dispatch({ type: "moveSelection", dRow: 0, dCol: e.shiftKey ? -1 : 1, extend: false });
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      e.preventDefault();
      dispatch({ type: "clearRange", anchor: selection.anchor, focus: selection.focus });
      return;
    }
    // 印字可能文字・IME入力は preventDefault せず textarea に入れる。
    // 入った内容が onEditorInput 経由で編集開始のトリガーになる
  }

  // ---- 座標 -> セル ----

  function svgPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function cellAtPoint(x: number, y: number): CellAddr | null {
    if (x < HEADER_W || y < HEADER_H || x >= totalW || y >= totalH) return null;
    let ri = 0;
    while (ri < doc.rows.length - 1 && ys[ri + 1] <= y) ri++;
    let ci = 0;
    while (ci < doc.cols.length - 1 && xs[ci + 1] <= x) ci++;
    return { row: doc.rows[ri].id, col: doc.cols[ci].id };
  }

  // ---- 選択ドラッグ ----

  function onCellPointerDown(e: React.PointerEvent) {
    const p = svgPoint(e);
    const addr = cellAtPoint(p.x, p.y);
    if (!addr) return;
    dragAnchor.current = addr;
    dispatch({ type: "setSelection", anchor: addr, focus: addr });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onCellPointerMove(e: React.PointerEvent) {
    if (!dragAnchor.current) return;
    const p = svgPoint(e);
    const addr = cellAtPoint(p.x, p.y);
    if (addr) {
      // 同一セル内の移動は reducer 側の同値チェックで no-op になる
      dispatch({ type: "setSelection", anchor: dragAnchor.current, focus: addr });
    }
  }

  function onCellPointerUp() {
    dragAnchor.current = null;
  }

  // ---- ヘッダのドラッグ選択(行・列をまとめて選ぶ) ----

  function selectRowRange(anchorRow: string, focusRow: string) {
    dispatch({
      type: "setSelection",
      anchor: { row: anchorRow, col: doc.cols[0].id },
      focus: { row: focusRow, col: doc.cols[doc.cols.length - 1].id },
    });
  }

  function selectColRange(anchorCol: string, focusCol: string) {
    dispatch({
      type: "setSelection",
      anchor: { row: doc.rows[0].id, col: anchorCol },
      focus: { row: doc.rows[doc.rows.length - 1].id, col: focusCol },
    });
  }

  function onCellDoubleClick(e: React.MouseEvent) {
    const p = svgPoint(e);
    const addr = cellAtPoint(p.x, p.y);
    if (!addr) return;
    dispatch({ type: "setSelection", anchor: addr, focus: addr });
    dispatch({ type: "startEdit" });
  }

  // ---- リサイズドラッグ ----

  function beginResize(
    e: React.PointerEvent,
    kind: "row" | "col",
    id: string,
    startSize: number,
  ) {
    e.stopPropagation();
    const p = svgPoint(e);
    setResize({
      kind,
      id,
      startPos: kind === "col" ? p.x : p.y,
      startSize,
      current: startSize,
    });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onResizeMove(e: React.PointerEvent) {
    if (!resize) return;
    const p = svgPoint(e);
    const pos = resize.kind === "col" ? p.x : p.y;
    setResize({ ...resize, current: resize.startSize + (pos - resize.startPos) });
  }

  function endResize() {
    if (!resize) return;
    if (resize.kind === "col") {
      dispatch({ type: "resizeCol", id: resize.id, width: resize.current });
    } else {
      dispatch({ type: "resizeRow", id: resize.id, height: resize.current });
    }
    setResize(null);
  }

  return (
    <div className="grid-scroll">
      <svg
        ref={svgRef}
        width={totalW + 1}
        height={totalH + 1}
        onPointerMove={onResizeMove}
        onPointerUp={() => {
          endResize();
          headerDrag.current = null;
        }}
        onMouseDown={(e) => {
          // 既定の mousedown はフォーカスを body へ移してしまい、常設エディタが
          // キー入力を受け取れなくなる。編集中のテキストエリア自身へのクリック
          // (キャレット移動)以外は既定動作を止めてフォーカスを保持する
          if (e.target !== editorRef.current) {
            e.preventDefault();
            editorRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        {/* セル背景 + 選択ハイライト */}
        <g
          onPointerDown={onCellPointerDown}
          onPointerMove={onCellPointerMove}
          onPointerUp={onCellPointerUp}
          onDoubleClick={onCellDoubleClick}
        >
          <rect
            x={HEADER_W}
            y={HEADER_H}
            width={totalW - HEADER_W}
            height={totalH - HEADER_H}
            fill="#fff"
          />
          {selRect && (
            <rect
              x={xs[selRect.c0]}
              y={ys[selRect.r0]}
              width={xs[selRect.c1 + 1] - xs[selRect.c0]}
              height={ys[selRect.r1 + 1] - ys[selRect.r0]}
              fill="#1a73e8"
              fillOpacity={0.08}
            />
          )}

          {/* グリッド線(結合セル内部の線は消すため、セル矩形単位で描く) */}
          {cellRects.map((c) => (
            <rect
              key={cellKey(c.addr)}
              x={c.x + 0.5}
              y={c.y + 0.5}
              width={c.w}
              height={c.h}
              fill="none"
              stroke="#dadce0"
            />
          ))}

          {/* セル内容 */}
          {cellRects.map((c) => {
            const key = cellKey(c.addr);
            const content = doc.cells[key];
            if (!content) return null;
            const v = values.get(key);
            const text = content.kind === "text" ? content.text : displayValue(v);
            const isError = v?.kind === "error";
            const isNumber = v?.kind === "number";
            return (
              <g key={key} clipPath={`url(#clip-${key})`}>
                <CellText
                  text={text}
                  x={c.x}
                  y={c.y}
                  width={c.w}
                  height={c.h}
                  align={isNumber ? "right" : "left"}
                  fill={isError ? "#c5221f" : undefined}
                />
              </g>
            );
          })}

          {/* アクティブセル(選択アンカー)の枠 */}
          {anchorRect && (
            <rect
              x={anchorRect.x + 1}
              y={anchorRect.y + 1}
              width={anchorRect.w - 2}
              height={anchorRect.h - 2}
              fill="none"
              stroke="#1a73e8"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
          {selRect && (
            <rect
              x={xs[selRect.c0] + 0.5}
              y={ys[selRect.r0] + 0.5}
              width={xs[selRect.c1 + 1] - xs[selRect.c0]}
              height={ys[selRect.r1 + 1] - ys[selRect.r0]}
              fill="none"
              stroke="#1a73e8"
              pointerEvents="none"
            />
          )}
        </g>

        {/* clipPath 定義(内容のあるセルのみ — 空セルはクリップ不要) */}
        <defs>
          {cellRects
            .filter((c) => doc.cells[cellKey(c.addr)])
            .map((c) => (
              <clipPath key={cellKey(c.addr)} id={`clip-${cellKey(c.addr)}`}>
                <rect x={c.x} y={c.y} width={c.w} height={c.h} />
              </clipPath>
            ))}
        </defs>

        {/* 列ヘッダ */}
        <g>
          <rect x={0} y={0} width={totalW} height={HEADER_H} fill="#f8f9fa" />
          {doc.cols.map((c, ci) => (
            <g key={c.id}>
              {/* fill="none" だと内側がヒットテスト対象外になるため
                  pointerEvents="all" で矩形全体をクリック可能にする */}
              <rect
                x={xs[ci] + 0.5}
                y={0.5}
                width={colWidths[ci]}
                height={HEADER_H}
                fill="none"
                stroke="#dadce0"
                pointerEvents="all"
                cursor="pointer"
                onPointerDown={() => {
                  headerDrag.current = { kind: "col", anchor: c.id };
                  selectColRange(c.id, c.id);
                }}
                onPointerEnter={() => {
                  const d = headerDrag.current;
                  if (d?.kind === "col") selectColRange(d.anchor, c.id);
                }}
              />
              <text
                x={xs[ci] + colWidths[ci] / 2}
                y={HEADER_H / 2 + CELL_FONT_SIZE * 0.35}
                textAnchor="middle"
                fontSize={CELL_FONT_SIZE - 1}
                fill="#5f6368"
                pointerEvents="none"
              >
                {colLabel(ci)}
              </text>
            </g>
          ))}
        </g>

        {/* 行ヘッダ */}
        <g>
          <rect x={0} y={HEADER_H} width={HEADER_W} height={totalH - HEADER_H} fill="#f8f9fa" />
          {doc.rows.map((r, ri) => (
            <g key={r.id}>
              <rect
                x={0.5}
                y={ys[ri] + 0.5}
                width={HEADER_W}
                height={rowHeights[ri]}
                fill="none"
                stroke="#dadce0"
                pointerEvents="all"
                cursor="pointer"
                onPointerDown={() => {
                  headerDrag.current = { kind: "row", anchor: r.id };
                  selectRowRange(r.id, r.id);
                }}
                onPointerEnter={() => {
                  const d = headerDrag.current;
                  if (d?.kind === "row") selectRowRange(d.anchor, r.id);
                }}
              />
              <text
                x={HEADER_W / 2}
                y={ys[ri] + rowHeights[ri] / 2 + CELL_FONT_SIZE * 0.35}
                textAnchor="middle"
                fontSize={CELL_FONT_SIZE - 1}
                fill="#5f6368"
                pointerEvents="none"
              >
                {ri + 1}
              </text>
            </g>
          ))}
          <rect x={0.5} y={0.5} width={HEADER_W} height={HEADER_H} fill="#f8f9fa" stroke="#dadce0" />
        </g>

        {/* リサイズの掴み代。ヘッダ矩形は pointerEvents="all" なので、隣接ヘッダに
            下半分を覆われないよう全ヘッダより後ろ(最前面)にまとめて描く */}
        <g>
          {doc.cols.map((c, ci) => (
            <rect
              key={`cg-${c.id}`}
              x={xs[ci + 1] - RESIZE_GRIP / 2}
              y={0}
              width={RESIZE_GRIP}
              height={HEADER_H}
              fill="transparent"
              cursor="col-resize"
              onPointerDown={(e) => beginResize(e, "col", c.id, c.width)}
            />
          ))}
          {doc.rows.map((r, ri) => (
            <rect
              key={`rg-${r.id}`}
              x={0}
              y={ys[ri + 1] - RESIZE_GRIP / 2}
              width={HEADER_W}
              height={RESIZE_GRIP}
              fill="transparent"
              cursor="row-resize"
              onPointerDown={(e) => beginResize(e, "row", r.id, r.height)}
            />
          ))}
        </g>

        {/* 編集オーバーレイ。非編集時も1pxで常駐しフォーカスとIMEを受け続ける */}
        {editorRect && (
          <foreignObject
            x={editorRect.x}
            y={editorRect.y}
            width={editing ? editorRect.w + 1 : 1}
            height={
              editing ? Math.max(editorRect.h + 1, CELL_LINE_HEIGHT + CELL_PAD * 2) : 1
            }
          >
            <textarea
              ref={editorRef}
              className={editing ? "cell-editor" : "cell-editor hidden"}
              defaultValue=""
              onInput={onEditorInput}
              onKeyDown={onEditorKeyDown}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                reportDraft(e.currentTarget.value);
              }}
              onBlur={() => {
                // 数式バーへ移る場合は commitEdit しない(下書きを引き継ぐ)
                if (editing?.where === "cell") dispatch({ type: "commitEdit" });
              }}
            />
          </foreignObject>
        )}
      </svg>
    </div>
  );
}
