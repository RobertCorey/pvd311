// Read the data behind a public Tableau view (Tableau Public), for dashboards whose download buttons are turned off.
// Two form POSTs, the same ones the page makes: startSession/viewing (session id, routing header) and bootstrapSession (the
// view's data dictionary plus every worksheet's columns as indices into it). The response is "<length>;<json>" chunks.

const BASE = 'https://public.tableau.com';

/** worksheet name → field caption → values (aliases resolved, so "$2,396" stays a formatted string). */
export type TableauSheets = Record<string, Record<string, (string | number | null)[]>>;

function chunks(body: string): any[] {
  const out: any[] = [];
  for (let i = 0; i < body.length; ) {
    const m = body.slice(i, i + 20).match(/^(\d+);/);
    if (!m) break;
    const start = i + m[0].length, n = Number(m[1]);
    out.push(JSON.parse(body.slice(start, start + n)));
    i = start + n;
  }
  return out;
}

/** Decodes a bootstrapSession response into worksheets. Exported for tests. */
export function decodeBootstrap(body: string): TableauSheets {
  const parts = chunks(body);
  const pm = parts[parts.length - 1]?.secondaryInfo?.presModelMap;
  if (!pm) return {};
  const dict: Record<string, any[]> = {};
  for (const seg of Object.values<any>(pm.dataDictionary?.presModelHolder?.genDataDictionaryPresModel?.dataSegments ?? {}))
    for (const col of seg.dataColumns) (dict[col.dataType] ??= []).push(...col.dataValues);
  const sheets: TableauSheets = {};
  for (const [name, v] of Object.entries<any>(pm.vizData?.presModelHolder?.genPresModelMapPresModel?.presModelMap ?? {})) {
    const pcd = v.presModelHolder?.genVizDataPresModel?.paneColumnsData;
    if (!pcd) continue;
    const cols: Record<string, (string | number | null)[]> = {};
    for (const c of pcd.vizDataColumns) {
      if (!c.fieldCaption) continue;
      c.paneIndices.forEach((pi: number, k: number) => {
        const pane = pcd.paneColumnsList[pi].vizPaneColumns[c.columnIndices[k]];
        const idx: number[] = pane.aliasIndices?.length ? pane.aliasIndices : pane.valueIndices ?? [];
        const vals = idx.map((a) => (a >= 0 ? dict[c.dataType]?.[a] : dict.cstring?.[-a - 1]) ?? null);
        if (vals.length) cols[c.fieldCaption] = vals;
      });
    }
    sheets[name] = cols;
  }
  return sheets;
}

/** All worksheets in a view (a dashboard view returns each of its worksheets). */
export async function tableauView(workbook: string, view: string): Promise<TableauSheets> {
  const loc = `${BASE}/views/${workbook}/${view}?:embed=y&:showVizHome=no`;
  const start = await fetch(`${BASE}/vizql/w/${workbook}/v/${view}/startSession/viewing?%3Aembed=y&%3AshowVizHome=no`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', referer: loc, 'tableau-viz-location': loc },
  });
  if (!start.ok) throw new Error(`${workbook}/${view}: startSession HTTP ${start.status}`);
  const cookie = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const route = start.headers.get('global-session-header');
  const cfg: any = await start.json();
  const body = new URLSearchParams({
    worksheetPortSize: '{"w":1280,"h":670}', dashboardPortSize: '{"w":1280,"h":670}', clientDimension: '{"w":1280,"h":720}',
    renderMapsClientSide: 'true', isBrowserRendering: 'true', browserRenderingThreshold: '100', formatDataValueLocally: 'false',
    navType: 'Nav', navSrc: 'Top', devicePixelRatio: '1', sheet_id: cfg.sheetId ?? view, showParams: cfg.showParams ?? '{}', stickySessionKey: cfg.stickySessionKey ?? '',
  });
  const boot = await fetch(`${BASE}${cfg.vizql_root}/bootstrapSession/sessions/${cfg.sessionid}`, {
    method: 'POST', body,
    headers: { accept: 'text/javascript', 'content-type': 'application/x-www-form-urlencoded', referer: loc, 'x-tsi-active-tab': view, cookie, ...(route ? { 'global-session-header': route } : {}) },
  });
  if (!boot.ok) throw new Error(`${workbook}/${view}: bootstrapSession HTTP ${boot.status}`);
  return decodeBootstrap(await boot.text());
}
