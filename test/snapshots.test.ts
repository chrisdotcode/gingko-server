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
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, move-only change', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: 'non-existant', position: 2.5, updatedAt: '2', delta: false, content: 'start'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: true, content: null}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, move-only change (reversed)', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: 'non-existant', position: 2.5, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '2', delta: false, content: 'start'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: 'non-existant', position: 2.5, updatedAt: '1', delta: true, content: null}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('various changes', () => {
    const snapshot1 = [
        {id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '976', delta: false, content: 'Ok, some things'},
        {id: '2', snapshot: 1, treeId: '1', parentId: '5', position: 0, updatedAt: '449', delta: false, content: ': lest'},
        {id: '3', snapshot: 1, treeId: '1', parentId: '1', position: 0, updatedAt: '371', delta: false, content: ' asdfsdaf asdf'},
        {id: '4', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '607', delta: false, content: 'Mid child'},
        {id: '5', snapshot: 1, treeId: '1', parentId: '1', position: 2, updatedAt: '455', delta: false, content: 'New card'}
    ];
    const snapshot2 = [
        {id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '976', delta: false, content: 'Ok, some things'},
        {id: '2', snapshot: 2, treeId: '1', parentId: '5', position: 0, updatedAt: '748', delta: false, content: 'A change'},
        {id: '3', snapshot: 2, treeId: '1', parentId: '1', position: 0, updatedAt: '845', delta: false, content: 'No keyboard mashing'},
        {id: '5', snapshot: 2, treeId: '1', parentId: null, position: 1, updatedAt: '690', delta: false, content: 'New card'}
    ];
    const expectedData = [
        {id: 'unchanged', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '', delta: true, content: JSON.stringify(['1'])},
        {id: '3', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '371', delta: true, content: "No keyboard mashing{@*=> asdfsdaf asdf"},
        {id: '2', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '449', delta: true, content: "A change{@*=>: lest"},
        {id: '5', snapshot: 1, treeId: '1', parentId: '1', position: 2, updatedAt: '455', delta: true, content: null},
        {id: '4', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '607', delta: true, content: 'Mid child'}
    ];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});