import {compact} from '../src/snapshots.ts';

test('compact', () => {
    expect(compact([])).toEqual([]);
});