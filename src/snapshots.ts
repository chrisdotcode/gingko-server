import _ from 'lodash';
import diff, {Diff} from "fast-diff";

interface SnapshotCompaction {
    snapshot: number;
    compactedData : SnapshotDeltaStringified[];
}

interface SnapshotRowBase{
    id: string;
    snapshot: number;
    treeId: string;
    parentId: string | number;
    position: number | null;
    delta: boolean;
}

interface SnapshotCard extends SnapshotRowBase {
    content: string;
}

interface SnapshotDeltaStringified extends SnapshotRowBase {
    content: string | null;
}

interface SnapshotDelta extends SnapshotRowBase {
    content: (string | number)[] | string  | null;
    unchanged: boolean;
}

export function compact (snapshotRows : SnapshotCard[]) : SnapshotCompaction[] {
    const snapshots = _.chain(snapshotRows).sortBy('snapshot').groupBy('snapshot').values().value();
    console.log(snapshots);

    if (snapshots.length == 0 || snapshots.length == 1) {
        return [];
    }
    const result : SnapshotCompaction[] = [];

    for (let i = 1; i < snapshots.length; i++) {
        const oldSnapshot = snapshots[i-1];
        const currSnapshot = snapshots[i];
        if (currSnapshot[0].delta == false, oldSnapshot[0].delta == false) {
            // Replace oldSnapshot with a delta-encoded version
            result.push({snapshot: oldSnapshot[0].snapshot, compactedData: delta(currSnapshot, oldSnapshot)});
        }
    }
    console.log(result);
    return result;
}

function delta(fromCards : SnapshotCard[], toCards : SnapshotCard[]) : SnapshotDeltaStringified[] {
    const deltasRaw : SnapshotDelta[] = [];
    const allCardIds = new Set([...fromCards.map(c => c.id), ...toCards.map(c => c.id)]);

    allCardIds.forEach(cardId => {
        const fromCard = fromCards.find(c => c.id == cardId);
        const toCard = toCards.find(c => c.id == cardId);
        if (fromCard && toCard) {
            deltasRaw.push(cardDiff(fromCard, toCard));
        } else if (!fromCard && toCard) {
            deltasRaw.push({...toCard, unchanged: false});
        }
    })
    const [unchanged, changed] = _.partition(deltasRaw, d => d.unchanged);
    const unchangedIds = unchanged.map(d => d.id);
    return [...changed, {id: 'unchanged', content: unchangedIds, position: null, parentId: 0, snapshot: toCards[0].snapshot, treeId: toCards[0].treeId, delta: true, unchanged: true}].map(stringifyDelta);
}

function stringifyDelta (d : SnapshotDelta) : SnapshotDeltaStringified {
    return { id: d.id, content: JSON.stringify(d.content), position: d.position, parentId: d.parentId, snapshot: d.snapshot, treeId: d.treeId, delta: true };
}

function cardDiff(fromCard : SnapshotCard, toCard : SnapshotCard) : SnapshotDelta {
    const contentChanged = fromCard.content != toCard.content;
    const parentChanged = fromCard.parentId != toCard.parentId;
    const positionChanged = fromCard.position != toCard.position;
    const unchanged = !contentChanged && !parentChanged && !positionChanged;

    const content = contentChanged ? diff(fromCard.content, toCard.content).map(diffMinimizer) : null;
    const parentId = parentChanged ? toCard.parentId : 0;
    const position = positionChanged ? toCard.position : null;
    return { id: toCard.id, content, position, parentId, snapshot: toCard.snapshot, treeId: toCard.treeId, delta: true, unchanged };
}

function diffMinimizer (d : Diff) : (string | number) {
    switch (d[0]) {
        case diff.EQUAL: return d[1].length;
        case diff.INSERT: return d[1];
        case diff.DELETE: return -d[1].length;
    }
}
