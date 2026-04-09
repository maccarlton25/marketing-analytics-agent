"use client";
import { useState, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Chart {
  id: string;
  base64: string;
}

interface Props {
  markdown: string | null;
  charts: Chart[];
  isLoading: boolean;
}

// Detect SVG (base64-encoded "<svg") vs PNG and return proper data URL
function chartDataUrl(base64: string): string {
  // base64 of "<sv" is "PHN2" — quick check for SVG content
  const mime = base64.startsWith("PHN2") ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${base64}`;
}

type Segment =
  | { type: "markdown"; content: string }
  | { type: "chart"; chart: Chart; description?: string };

export default function ReportPanel({ markdown, charts, isLoading }: Props) {
  const [fullscreenChart, setFullscreenChart] = useState<Chart | null>(null);

  const chartMap = useMemo(() => {
    const map = new Map<string, Chart>();
    for (const c of charts) map.set(c.id, c);
    return map;
  }, [charts]);

  // Split markdown into segments of text and inline charts
  const segments: Segment[] = useMemo(() => {
    if (!markdown) return [];

    // Match chart references and consume surrounding decoration like:
    //   📊 **chart_1** — description text
    //   chart_1
    //   Chart 1 — Some label
    // Group 1: chart number, Group 2: optional description after dash
    const pattern = /[^\S\n]*(?:📊\s*)?(?:\*{1,2})?chart[_ ](\d+)(?:\*{1,2})?(?:\s*[—–-]\s*([^\n]*))?\n?/gi;
    const result: Segment[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
      const chartId = `chart_${match[1]}`;
      const description = match[2]?.trim() || undefined;
      const chart = chartMap.get(chartId);

      // Add preceding text
      if (match.index > lastIndex) {
        const text = markdown.slice(lastIndex, match.index).trim();
        if (text) result.push({ type: "markdown", content: text });
      }

      if (chart) {
        result.push({ type: "chart", chart, description });
      }
      // If no matching chart, just skip the reference

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < markdown.length) {
      const text = markdown.slice(lastIndex).trim();
      if (text) result.push({ type: "markdown", content: text });
    }

    return result;
  }, [markdown, chartMap]);

  const handleChartDoubleClick = useCallback((chart: Chart) => {
    setFullscreenChart(chart);
  }, []);

  if (isLoading && !markdown && charts.length === 0) {
    return (
      <div className="text-center text-gray-400 text-sm p-8">
        <svg className="animate-spin h-5 w-5 mx-auto mb-3 text-gray-300" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p>Generating analysis...</p>
      </div>
    );
  }

  if (!markdown && charts.length === 0) {
    return (
      <div className="text-center text-gray-400 text-sm p-8">
        <p>Your analysis report will appear here</p>
        <p className="text-xs mt-2">Ask a question about your data to get started</p>
      </div>
    );
  }

  return (
    <>
      <div className="p-6 overflow-y-auto h-full">
        {segments.map((seg, i) =>
          seg.type === "markdown" ? (
            <div key={i} className="prose prose-sm prose-gray max-w-none">
              <Markdown remarkPlugins={[remarkGfm]}>{seg.content}</Markdown>
            </div>
          ) : (
            <div key={i} className="my-4">
              <div className="border border-gray-100 rounded-lg overflow-hidden bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={chartDataUrl(seg.chart.base64)}
                  alt={seg.chart.id}
                  className="w-full h-auto cursor-pointer"
                  onDoubleClick={() => handleChartDoubleClick(seg.chart)}
                  title="Double-click to view fullscreen"
                />
                <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-t border-gray-100">
                  <span className="text-[10px] text-gray-400 font-mono">{seg.chart.id}</span>
                  <a
                    href={chartDataUrl(seg.chart.base64)}
                    download={`${seg.chart.id}.png`}
                    className="text-[10px] text-gray-400 hover:text-gray-600"
                  >
                    Download
                  </a>
                </div>
              </div>
              {seg.description && (
                <p className="text-xs text-gray-500 italic mt-1.5">{seg.description}</p>
              )}
            </div>
          ),
        )}
      </div>

      {/* Fullscreen overlay */}
      {fullscreenChart && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setFullscreenChart(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={chartDataUrl(fullscreenChart.base64)}
              alt={fullscreenChart.id}
              className="max-w-full max-h-[90vh] rounded-lg shadow-2xl"
            />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3">
              <span className="text-xs text-white/60 bg-black/50 rounded px-2 py-1 font-mono">
                {fullscreenChart.id}
              </span>
              <a
                href={chartDataUrl(fullscreenChart.base64)}
                download={`${fullscreenChart.id}.png`}
                className="text-xs text-white/60 bg-black/50 rounded px-2 py-1 hover:text-white"
                onClick={(e) => e.stopPropagation()}
              >
                Download PNG
              </a>
            </div>
            <button
              onClick={() => setFullscreenChart(null)}
              className="absolute top-2 right-2 text-white/60 hover:text-white bg-black/50 rounded-full w-8 h-8 flex items-center justify-center"
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </>
  );
}
