import { describe, expect, it } from 'vitest';
import { decodeBootstrap } from '../src/tableau.ts';

const frame = (o: unknown) => { const s = JSON.stringify(o); return `${s.length};${s}`; };

describe('decodeBootstrap', () => {
  it('resolves value and alias indices against the data dictionary', () => {
    const secondary = {
      secondaryInfo: { presModelMap: {
        dataDictionary: { presModelHolder: { genDataDictionaryPresModel: { dataSegments: { 0: { dataColumns: [
          { dataType: 'integer', dataValues: [669, 482] },
          { dataType: 'cstring', dataValues: ['02909', '02908', '$2,396'] },
        ] } } } } },
        vizData: { presModelHolder: { genPresModelMapPresModel: { presModelMap: { 'Cases by ZIP': { presModelHolder: { genVizDataPresModel: { paneColumnsData: {
          vizDataColumns: [
            { fieldCaption: 'Zip Code', dataType: 'cstring', paneIndices: [0], columnIndices: [0] },
            { fieldCaption: 'Cases', dataType: 'integer', paneIndices: [0], columnIndices: [1] },
            { fieldCaption: 'Rent', dataType: 'real', paneIndices: [0], columnIndices: [2] },
          ],
          paneColumnsList: [{ vizPaneColumns: [{ valueIndices: [0, 1] }, { valueIndices: [0, 1] }, { aliasIndices: [-3, -3] }] }],
        } } } } } } } },
      } },
    };
    const body = frame({ primary: true }) + frame(secondary);
    expect(decodeBootstrap(body)).toEqual({ 'Cases by ZIP': { 'Zip Code': ['02909', '02908'], Cases: [669, 482], Rent: ['$2,396', '$2,396'] } });
  });
});
