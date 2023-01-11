import _ from 'lodash';
import * as fastDiff from "fast-diff";

export function diff(fromCards, toCards) {
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
    return deltasChanged.concat({id: 'unchanged', content: unchangedIds, parentId: 0, position: null});
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

    const content = contentChanged ? fastDiff(fromCard.content, toCard.content).map(diffMinimizer) : null;
    const parentId = parentChanged ? toCard.parentId : 0;
    const position = positionChanged ? toCard.pos : null;
    return { id: toCard.id, content, position, parentId };
}

function diffMinimizer (d) {
    if (d[0] == fastDiff.EQUAL) {
        return d[1].length;
    }

    if (d[0] == fastDiff.INSERT) {
        return d[1];
    }

    if (d[0] == fastDiff.DELETE) {
        return -1*d[1].length;
    }
}
