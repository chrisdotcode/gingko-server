import {compact} from '../dist/snapshots.js';

test('compacting empty should return empty', () => {
    expect(compact([])).toEqual([]);
});

test('compacting one snapshot should return empty', () => {
    expect(compact([{id: '1', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '1', delta: false, content: '1'}])).toEqual([]);
});

test('compacting two identical snapshots should return unchanged row', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const expectedDelta = [{id: 'unchanged', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '', delta: true, content: JSON.stringify(['1'])}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedDelta}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, content-only change', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '2', delta: false, content: 'end'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '1', delta: true, content: JSON.stringify([-3, "start"])}]
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2]))
        .toEqual(expected);
});