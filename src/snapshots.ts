import _ from 'lodash';
import diff, {Diff} from "fast-diff";

export interface SnapshotCompaction {
    snapshot: number;
    treeId: string;
    compactedData : SnapshotDeltaStringified[];
}

interface SnapshotRowBase{
    id: string;
    snapshot: number;
    treeId: string;
    parentId: string | number;
    position: number | null;
    updatedAt: string;
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

    if (snapshots.length == 0 || snapshots.length == 1) {
        return [];
    }
    const result : SnapshotCompaction[] = [];

    for (let i = 1; i < snapshots.length; i++) {
        const oldSnapshot = snapshots[i-1];
        const currSnapshot = snapshots[i];
        if (currSnapshot[0].delta == false, oldSnapshot[0].delta == false) {
            // Replace oldSnapshot with a delta-encoded version
            result.push({snapshot: oldSnapshot[0].snapshot, treeId: oldSnapshot[0].treeId, compactedData: delta(currSnapshot, oldSnapshot)});
        }
    }
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
    if (unchangedIds.length > 0) {
        return [{id: 'unchanged', content: unchangedIds, position: null, parentId: 0, snapshot: toCards[0].snapshot, treeId: toCards[0].treeId, updatedAt: '', delta: true, unchanged: true}, ...changed].map(stringifyDelta);
    } else {
        return changed.map(stringifyDelta);
    }
}

function stringifyDelta (d : SnapshotDelta) : SnapshotDeltaStringified {
    return { id: d.id, content: d.content == null ? null : JSON.stringify(d.content), position: d.position, parentId: d.parentId, snapshot: d.snapshot, treeId: d.treeId, updatedAt: d.updatedAt, delta: true };
}

function cardDiff(fromCard : SnapshotCard, toCard : SnapshotCard) : SnapshotDelta {
    const contentChanged = fromCard.content != toCard.content;
    const parentChanged = fromCard.parentId != toCard.parentId;
    const positionChanged = fromCard.position != toCard.position;
    const unchanged = !contentChanged && !parentChanged && !positionChanged;

    const content = contentChanged ? diff(fromCard.content, toCard.content).map(diffMinimizer) : null;
    const parentId = parentChanged ? toCard.parentId : 0;
    const position = positionChanged ? toCard.position : null;
    return { id: toCard.id, content, position, parentId, snapshot: toCard.snapshot, treeId: toCard.treeId, updatedAt: toCard.updatedAt, delta: true, unchanged };
}

function diffMinimizer (d : Diff) : (string | number) {
    switch (d[0]) {
        case diff.EQUAL: return d[1].length;
        case diff.INSERT: return d[1];
        case diff.DELETE: return -d[1].length;
    }
}

function expand(base : SnapshotCard[], delta : SnapshotDeltaStringified[]) : SnapshotCard[] {
    const unchanged = delta.find(d => d.id == 'unchanged')!;
    const unchangedIds = JSON.parse(unchanged.content!) as string[];
    const unchangedCards = base.filter(c => unchangedIds.includes(c.id));
    const changedCards = delta.filter(d => d.id != 'unchanged').map(d => expandCard(base, d));
    return [...unchangedCards, ...changedCards];
}

function expandCard(base : SnapshotCard[], delta : SnapshotDeltaStringified) : SnapshotCard {
    const deltaParsed = parseDelta(delta);
    const baseCard = base.find(c => c.id == deltaParsed.id)!;
    let content;
    if (deltaParsed.content == null) {
        content = baseCard.content;
    } else if (typeof deltaParsed.content == 'string') {
        content = deltaParsed.content;
    } else {
        content = applyDiff(baseCard.content, deltaParsed.content);
    }
    return { id: deltaParsed.id, content, position: deltaParsed.position, parentId: deltaParsed.parentId, snapshot: deltaParsed.snapshot, treeId: deltaParsed.treeId, updatedAt: deltaParsed.updatedAt, delta: false };
}

function parseDelta(delta : SnapshotDeltaStringified) : SnapshotDelta {
    return { id: delta.id, content: JSON.parse(delta.content!) as (string | number)[], position: delta.position, parentId: delta.parentId, snapshot: delta.snapshot, treeId: delta.treeId, updatedAt: delta.updatedAt, delta: true, unchanged: false };
}

function applyDiff(base : string, diff : (string | number)[]) : string {
    let result = '';
    let baseIndex = 0;
    for (let i = 0; i < diff.length; i++) {
        const d = diff[i];
        if (typeof d == 'number') {
            if (d > 0) {
                result += base.substr(baseIndex, d);
                baseIndex += d;
            } else {
                baseIndex -= d;
            }
        } else {
            result += d;
        }
    }
    return result;
}