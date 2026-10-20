// Drawing a Vega-Lite chart with the app's look: Visualize's panel and the Saved tab's chart cards.

export type ChartView = { toImageURL(type: string, scale?: number): Promise<string> };

/**
 * Series colors for two or more series (the dataviz reference palette, validated for both
 * modes and color-vision deficiency). A single series uses the ink color, so the app stays
 * monochrome (decision 13) unless color has to tell series apart.
 */
const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** Vega-Lite config from the app's tokens: thin marks, recessive axes and grid, text in ink, not series colors. */
export function chartConfig(): Record<string, unknown> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const ink = v('--fg');
  const ink2 = v('--fg-2');
  const font = v('--font') || 'Segoe UI, sans-serif';
  return {
    background: 'transparent',
    font,
    view: { stroke: null },
    axis: {
      labelColor: ink2,
      titleColor: ink2,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 500,
      gridColor: v('--border'),
      domainColor: v('--border-strong'),
      tickColor: v('--border-strong'),
      labelLimit: 120,
    },
    legend: { labelColor: ink2, titleColor: ink2, labelFontSize: 11, titleFontSize: 11, orient: 'top', symbolType: 'circle' },
    range: { category: dark ? SERIES.dark : SERIES.light },
    mark: { color: ink },
    bar: { cornerRadiusEnd: 4, stroke: 'transparent' },
    line: { strokeWidth: 2 },
    point: { size: 64, filled: true },
    area: { opacity: 0.85 },
  };
}

/**
 * Draws `spec` into `el` as SVG and returns the view and a finalize, or throws. The page's CSP
 * forbids eval, so expressions run through vega's interpreter instead of new Function.
 */
export async function drawChart(el: HTMLElement, spec: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ view: ChartView; finalize: () => void }> {
  const [{ default: embed }, { expressionInterpreter }] = await Promise.all([import('vega-embed'), import('vega-interpreter')]);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const r = await embed(el, { ...spec, ...extra, config: chartConfig() } as never, {
    actions: false,
    renderer: 'svg',
    tooltip: { theme: dark ? 'dark' : 'light' },
    ast: true,
    expr: expressionInterpreter,
  });
  return { view: r.view, finalize: () => r.finalize() };
}
