import _ from 'lodash';
import diff from "fast-diff";

interface SnapshotRow {
    snapshot: number;
    treeId: string;
    id: string;
    content: string;
    parentId: string | null | number;
    position: number | null;
    delta: true;
}

interface SnapshotDelta {
    id: Unchanged | string,
    content: [string | number] |string,
    parentId: string | number,
    position: number | null,
}
type Unchanged = {type: 'unchanged'};
function Unchanged() { return {type: 'unchanged'}; }


export function compact (snapshots : SnapshotRow[]) : SnapshotRow[] {
    console.log('compact', snapshots);
    return [];
}

function delta(fromCards, toCards) : SnapshotDelta[] {
    const deltasRaw = [];
    const allCardIds = new Set([...fromCards.map(c => c.id), ...toCards.map(c => c.id)]);

    allCardIds.forEach(cardId => {
        const fromCard = fromCards.find(c => c.id == cardId);
        const toCard = toCards.find(c => c.id == cardId);
        if (fromCard && toCard) {
            deltasRaw.push(cardDiff(fromCard, toCard));
        } else if (!fromCard && toCard) {
            deltasRaw.push(cardInsertDelta(toCard));
        }
    })
    const [unchangedIds, deltasChanged] = _.chain(deltasRaw).partition(d => typeof d == 'string').value();
    return deltasChanged.concat({id: Unchanged(), content: unchangedIds, parentId: 0, position: null});
}

function cardInsertDelta(card) {
    return _.omit(card, ['snapshot','treeId', 'updatedAt']);
}

function cardDiff(fromCard, toCard) {
    const contentChanged = fromCard.content != toCard.content;
    const parentChanged = fromCard.parentId != toCard.parentId;
    const positionChanged = fromCard.position != toCard.position;

    if (!contentChanged && !parentChanged && !positionChanged) {
        return fromCard.id
    }

    const content = contentChanged ? diff(fromCard.content, toCard.content).map(diffMinimizer) : null;
    const parentId = parentChanged ? toCard.parentId : 0;
    const position = positionChanged ? toCard.pos : null;
    return { id: toCard.id, content, position, parentId };
}

function diffMinimizer (d) {
    if (d[0] == diff.EQUAL) {
        return d[1].length;
    }

    if (d[0] == diff.INSERT) {
        return d[1];
    }

    if (d[0] == diff.DELETE) {
        return -1*d[1].length;
    }
}
