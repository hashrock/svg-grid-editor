// pretext によるセル内テキストのレイアウト。
// SVG の <text> は自動折り返しをしないため、pretext で行分割を計算し
// 各行を <tspan> として配置する。DOM計測を使わないのでリフローが起きない。
// レイアウト結果は (テキスト, 内幅) をキーにキャッシュし、行の自動高さ計算
// (measureCellHeight)と描画(CellText)が同じ1回の計算を共有する。

import {
  prepareWithSegments,
  layoutWithLines,
  type LayoutLinesResult,
} from "@chenglou/pretext";

export const CELL_FONT_SIZE = 13;
export const CELL_FONT = `${CELL_FONT_SIZE}px sans-serif`;
export const CELL_LINE_HEIGHT = 18;
export const CELL_PAD = 5;

const layoutCache = new Map<string, LayoutLinesResult>();
const LAYOUT_CACHE_MAX = 2000;

export function layoutCellText(text: string, cellWidth: number): LayoutLinesResult {
  const innerWidth = Math.max(cellWidth - CELL_PAD * 2, 8);
  const key = `${innerWidth}|${text}`;
  let result = layoutCache.get(key);
  if (!result) {
    if (layoutCache.size >= LAYOUT_CACHE_MAX) layoutCache.clear();
    // pre-wrap: セル内の明示的な改行(Shift+Enter入力)を保持する
    const prepared = prepareWithSegments(text, CELL_FONT, { whiteSpace: "pre-wrap" });
    result = layoutWithLines(prepared, innerWidth, CELL_LINE_HEIGHT);
    layoutCache.set(key, result);
  }
  return result;
}

/** セル幅に対するテキストの必要高さ(パディング込み)。行の自動高さ計算に使う */
export function measureCellHeight(text: string, cellWidth: number): number {
  return layoutCellText(text, cellWidth).height + CELL_PAD * 2;
}

interface Props {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "right";
  fill?: string;
}

export function CellText({ text, x, y, width, height, align, fill }: Props) {
  if (text === "") return null;

  const maxLines = Math.max(1, Math.floor((height - CELL_PAD) / CELL_LINE_HEIGHT));
  const lines = layoutCellText(text, width).lines.slice(0, maxLines);

  const tx = align === "right" ? x + width - CELL_PAD : x + CELL_PAD;
  return (
    <text
      fontSize={CELL_FONT_SIZE}
      fontFamily="sans-serif"
      textAnchor={align === "right" ? "end" : "start"}
      fill={fill ?? "#1a1a1a"}
    >
      {lines.map((line, i) => (
        <tspan
          key={i}
          x={tx}
          y={y + CELL_PAD + CELL_LINE_HEIGHT * i + CELL_FONT_SIZE * 0.85}
        >
          {line.text}
        </tspan>
      ))}
    </text>
  );
}
